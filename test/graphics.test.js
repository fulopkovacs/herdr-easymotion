"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HINT_COLORS,
  backgroundForEnv,
  colorForIndex,
  createHintPngBase64,
  createOverlayParams,
  getCachedCellSize,
  getCachedHintBase64,
  paneIdBackgroundForEnv,
  setCachedCellSize,
} = require("../src/graphics");

test("backgroundForEnv supports explicit light and dark appearances", () => {
  assert.deepEqual(backgroundForEnv({ HERDR_EASYMOTION_APPEARANCE: "light" }), [251, 241, 199, 255]);
  assert.deepEqual(backgroundForEnv({ HERDR_EASYMOTION_APPEARANCE: "dark" }), [29, 32, 33, 255]);
  assert.deepEqual(paneIdBackgroundForEnv({ HERDR_EASYMOTION_APPEARANCE: "light" }), [255, 255, 255, 160]);
  assert.deepEqual(paneIdBackgroundForEnv({ HERDR_EASYMOTION_APPEARANCE: "dark" }), [0, 0, 0, 160]);
});

function rgbDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

test("createHintPngBase64 creates a PNG image", () => {
  const buffer = Buffer.from(createHintPngBase64("1", 80, 120), "base64");

  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("createHintPngBase64 rejects invalid dimensions", () => {
  assert.throws(() => createHintPngBase64("1", 0, 20), /positive safe integers/);
  assert.throws(() => createHintPngBase64("1", 20.5, 20), /positive safe integers/);
});

test("createHintPngBase64 explains when figlet is unavailable", () => {
  assert.throws(
    () => createHintPngBase64("1", 81, 120, HINT_COLORS[0], "", { FIGLET_BIN: "/does/not/exist" }),
    /figlet is required.*not found/i,
  );
});

test("createHintPngBase64 renders letter shortcuts distinctly", () => {
  const one = createHintPngBase64("1", 80, 120);

  for (const shortcut of "abcdefghijklmnopqrstuvwxyz") {
    assert.notEqual(createHintPngBase64(shortcut, 80, 120), one);
  }
});

test("createHintPngBase64 renders pane ids distinctly", () => {
  const firstPane = createHintPngBase64("1", 120, 180, HINT_COLORS[0], "w1:p1");
  const secondPane = createHintPngBase64("1", 120, 180, HINT_COLORS[0], "w1:p2");

  assert.notEqual(firstPane, secondPane);
});

test("createHintPngBase64 preserves pane id letter casing", () => {
  const lowercase = createHintPngBase64("1", 120, 180, HINT_COLORS[0], "w3:pz");
  const uppercase = createHintPngBase64("1", 120, 180, HINT_COLORS[0], "w3:PZ");

  assert.notEqual(lowercase, uppercase);
});

test("hint colors use high-contrast ANSI neighbors", () => {
  assert.deepEqual(HINT_COLORS.map((color) => color.slice(0, 3)), [
    [220, 88, 88],
    [36, 114, 200],
    [210, 150, 45],
    [75, 185, 210],
    [205, 49, 49],
    [80, 150, 220],
    [229, 192, 64],
    [17, 168, 205],
    [205, 105, 205],
    [13, 188, 121],
    [188, 63, 188],
    [55, 190, 120],
  ]);

  for (let index = 0; index < HINT_COLORS.length; index += 1) {
    const next = (index + 1) % HINT_COLORS.length;
    assert.ok(rgbDistance(colorForIndex(index), colorForIndex(next)) >= 190);
  }
});

test("createOverlayParams covers the target pane viewport", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-graphics-"));
  const params = createOverlayParams(
    {
      shortcut: "2",
      paneId: "w1:p2",
      rect: { width: 40, height: 12, x: 20, y: 4 },
    },
    { cell_width_px: 9, cell_height_px: 18 },
    1,
    { env: { HERDR_PLUGIN_STATE_DIR: dir, HERDR_EASYMOTION_APPEARANCE: "dark" } },
  );

  try {
    assert.equal(params.pane_id, "w1:p2");
    assert.equal(params.format, "png");
    assert.equal(params.image_width, 117);
    assert.equal(params.image_height, 216);
    assert.deepEqual(params.placement, {
      viewport_col: 13,
      viewport_row: 0,
      grid_cols: 13,
      grid_rows: 12,
    });
    assert.ok(params.data_base64.length > 0);
    assert.equal(
      getCachedHintBase64("v10:2:w1:p2:117:216:36,114,200,245:29,32,33,255:54:144:18", {
        HERDR_PLUGIN_STATE_DIR: dir,
        HERDR_EASYMOTION_APPEARANCE: "dark",
      }),
      params.data_base64,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOverlayParams keeps the hint floor while scaling the pane number", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-graphics-"));
  const options = { env: { HERDR_PLUGIN_STATE_DIR: dir, HERDR_EASYMOTION_APPEARANCE: "dark" } };
  const graphicsInfo = { cell_width_px: 9, cell_height_px: 18 };
  const target = {
    shortcut: "5",
    paneId: "w3:p15",
    rect: { width: 40, height: 12, x: 0, y: 0 },
  };

  try {
    const small = createOverlayParams(target, graphicsInfo, 4, options);
    const smaller = createOverlayParams({ ...target, rect: { ...target.rect, height: 6 } }, graphicsInfo, 4, options);

    assert.deepEqual([small.image_width, small.image_height], [117, 216]);
    assert.deepEqual([smaller.image_width, smaller.image_height], [117, 216]);
    assert.notEqual(smaller.data_base64, small.data_base64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cell size cache ignores invalid dimensions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-graphics-"));
  const env = { HERDR_PLUGIN_STATE_DIR: dir };

  try {
    setCachedCellSize({ cell_width_px: 0, cell_height_px: 18 }, env);
    assert.equal(getCachedCellSize(env), null);

    setCachedCellSize({ cell_width_px: 9, cell_height_px: 18 }, env);
    assert.deepEqual(getCachedCellSize(env), { cell_width_px: 9, cell_height_px: 18 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
