"use strict";
/* eslint-disable no-control-regex -- Decode and check terminal control sequences emitted by the renderer. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderSnapshot, snapshotRows } = require("../dist/snapshot");
const { buildTargets } = require("../dist/core");

const env = { HERDR_EASYMOTION_APPEARANCE: "dark" };

// Decode the renderer's cursor-addressed output, rather than just looking for
// labels in a string: an ID must actually be drawn inside its own pane.
function screen(output, width, height) {
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));
  let x = 0;
  let y = 0;
  for (const match of output.matchAll(/\x1b\[([0-?]*)([ -/]*)([@-~])|([^\x1b]+)/g)) {
    if (match[3] === "H") {
      const [row = "1", col = "1"] = match[1].split(";");
      y = Number(row || 1) - 1;
      x = Number(col || 1) - 1;
    } else if (match[4]) {
      for (const char of match[4]) {
        if (grid[y] && x >= 0 && x < width) grid[y][x] = char;
        x++;
      }
    }
  }
  return grid.map((row) => row.join(""));
}

function snapshot(paneId, fill, width = 37, height = 14) {
  return { paneId, text: Array(height).fill(fill.repeat(width)).join("\r\n") };
}

const layout = {
  area: { x: 0, y: 0, width: 80, height: 32 },
  focused_pane_id: "w1:p1",
  panes: [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 40, height: 16 } },
    { pane_id: "w1:p2", rect: { x: 40, y: 0, width: 40, height: 16 } },
    { pane_id: "w1:p3", rect: { x: 0, y: 16, width: 80, height: 16 } },
  ],
};
const targets = buildTargets(layout, new Map(), "w1:p1", { includeCurrent: true });
const snapshots = [snapshot("w1:p1", "A"), snapshot("w1:p2", "B"), snapshot("w1:p3", "C", 77)];

test("captured contents and large shortcuts are drawn in the corresponding pane regions", () => {
  const output = renderSnapshot(layout, targets, snapshots, 77, 30, env);
  const rows = screen(output, 77, 30);
  assert.equal(rows[0][0], "A");
  assert.equal(rows[0][40], "B");
  assert.equal(rows[16][0], "C");
  for (const [id, xMin, xMax, yMin, yMax] of [
    ["w1:p1", 0, 39, 0, 15],
    ["w1:p2", 40, 77, 0, 15],
    ["w1:p3", 0, 77, 16, 30],
  ]) {
    const y = rows.findIndex((row) => row.includes(id));
    assert.ok(y >= yMin && y < yMax, `${id} row ${y} outside its pane`);
    const x = rows[y].indexOf(id);
    assert.ok(x >= xMin && x + id.length <= xMax, `${id} column ${x} outside its pane`);
    assert.ok(
      rows.slice(yMin, yMax).some((row) => /[█▀▄]/.test(row.slice(xMin, xMax))),
      "large shortcut missing",
    );
  }
  assert.doesNotMatch(output, /Jump to pane|Positions are column,row/);
});

test("sidebar and tab-bar offsets do not shift the reconstructed pane positions", () => {
  const shifted = {
    ...layout,
    area: { ...layout.area, x: 28, y: 3 },
    panes: layout.panes.map((pane) => ({
      ...pane,
      rect: { ...pane.rect, x: pane.rect.x + 28, y: pane.rect.y + 3 },
    })),
  };
  const shiftedTargets = buildTargets(shifted, new Map(), "w1:p1", { includeCurrent: true });
  assert.equal(
    renderSnapshot(shifted, shiftedTargets, snapshots, 77, 30, env),
    renderSnapshot(layout, targets, snapshots, 77, 30, env),
  );
});

test("small panes use compact shortcuts and IDs instead of oversized FIGlet art", () => {
  const tiny = {
    area: { x: 0, y: 0, width: 24, height: 6 },
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 12, height: 6 } },
      { pane_id: "w1:p2", rect: { x: 12, y: 0, width: 12, height: 6 } },
    ],
  };
  const targets = buildTargets(tiny, new Map(), "w1:p1", { includeCurrent: true });
  const output = renderSnapshot(tiny, targets, [], 21, 4, env);
  const rows = screen(output, 21, 4);
  assert.ok(rows.some((row) => row.slice(0, 11).trim() === "1"));
  assert.ok(rows.some((row) => row.slice(12).trim() === "2"));
  assert.match(rows.join("\n"), /w1:p1/);
  assert.match(rows.join("\n"), /w1:p2/);
});

test("SGR colors, wide characters, combining marks, and tabs occupy correct cells", () => {
  const [row] = snapshotRows("\x1b[31m界e\u0301\tZ\x1b[0m");
  assert.equal(row[0].text, "界");
  assert.equal(row[0].width, 2);
  assert.equal(row[1].width, 0);
  assert.equal(row[2].text, "e\u0301");
  assert.equal(row[8].text, "Z");
  assert.equal(row[8].style, "\x1b[31m");
  assert.equal(
    snapshotRows("[31m literal")[0]
      .map((cell) => cell.text)
      .join(""),
    "[31m literal",
  );
});

test("snapshot controls cannot replay clipboard, graphics, cursor motion, or bells", () => {
  const text = "safe\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1b[99;99H\x1b_Ga=T;data\x1b\\\x07\x1b[31m red";
  const rows = snapshotRows(text);
  assert.equal(rows[0].map((cell) => cell.text).join(""), "safe red");
  const output = renderSnapshot(layout, targets, [{ paneId: "w1:p1", text }], 77, 30, env);
  assert.doesNotMatch(output, /\x1b\]52|\x1b_G|\x1b\[99;99H|\x07|ZXZpbA/);
  // Snapshot styles are re-emitted after a reset, dimmed, and still red.
  assert.match(output, /\x1b\[0;2;31m/);
});

test("SGR sequences are normalized into one current style instead of accumulating", () => {
  const [row] = snapshotRows("\x1b[1m\x1b[31m\x1b[32m\x1b[44mA\x1b[22;39mB\x1b[0;7mC\x1b[mD");
  assert.deepEqual(
    row.map((cell) => cell.style),
    ["\x1b[1;32;44m", "\x1b[44m", "\x1b[7m", ""],
  );
  const [colors] = snapshotRows("\x1b[38;5;196;48:2::1:2:3;4:3mA\x1b[38;5mB\x1b[38;2;9mC");
  assert.equal(colors[0].style, "\x1b[4:3;38;5;196;48:2::1:2:3m");
  // Truncated extended colors use 0 for missing components, like terminals do.
  assert.equal(colors[1].style, "\x1b[4:3;38;5;0;48:2::1:2:3m");
  assert.equal(colors[2].style, "\x1b[4:3;38;2;9;0;0;48:2::1:2:3m");
});

test("long colorful snapshots render in bounded output without repainting blank cells", () => {
  const busy = Array.from({ length: 14 }, () =>
    Array.from({ length: 37 }, (_, i) => `\x1b[3${i % 8}m\x1b[1m${"x"}`).join(""),
  ).join("\r\n");
  const output = renderSnapshot(
    layout,
    targets,
    [{ paneId: "w1:p1", text: busy }, snapshot("w1:p2", " ")],
    77,
    30,
    env,
  );
  // Every pane-1 cell changes color, so each costs at most one style switch.
  assert.ok(output.length < 40_000, `output is ${output.length} bytes`);
  assert.doesNotMatch(output, /(?:\x1b\[3\dm){2}/);
  const rows = screen(output, 77, 30);
  assert.equal(rows[0].slice(0, 3), "xxx");
  // Pane 2 is blank, so nothing is drawn there except its border and badge.
  assert.equal(rows[0].slice(41), " ".repeat(36));
});

test("a closing pane's failed capture still leaves all spatial hints usable", () => {
  const output = renderSnapshot(
    layout,
    targets,
    [{ paneId: "w1:p1", text: "", error: "pane_not_found" }],
    77,
    30,
    env,
  );
  const rows = screen(output, 77, 30);
  assert.match(rows.join("\n"), /Snapshot unavailable/);
  assert.match(rows.join("\n"), /w1:p1/);
  assert.match(rows.join("\n"), /w1:p2/);
});

test("clipping on a smaller viewport never writes cursor positions outside its bounds", () => {
  const output = renderSnapshot(layout, targets, snapshots, 20, 8, env);
  for (const match of output.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    assert.ok(Number(match[1]) <= 8);
    assert.ok(Number(match[2]) <= 20);
  }
  assert.ok(output.startsWith("\x1b[?7l"));
  assert.ok(output.endsWith("\x1b[0m\x1b[?7h\x1b[H"));
});
