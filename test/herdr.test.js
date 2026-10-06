"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} = require("node:fs");
const { spawn } = require("node:child_process");

const {
  MAX_TIMEOUT_MS,
  paneGraphicsSetMany,
  request,
  requestTimeoutMs,
  settleRequests,
} = require("../dist/herdr");

function listen(server, socketPath) {
  return new Promise((resolve) => server.listen(socketPath, resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runNode(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("snapshot picker survives launcher handoff and selects without graphics APIs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easymotion-handoff-"));
  const socketPath = path.join(dir, "api.sock");
  const fakeHerdrPath = path.join(dir, "herdr.js");
  const layout = {
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } },
      { pane_id: "w1:p2", rect: { x: 80, y: 0, width: 80, height: 24 } },
    ],
  };
  writeFileSync(
    fakeHerdrPath,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ result: { layout } }))});\n`,
  );
  chmodSync(fakeHerdrPath, 0o755);
  const methods = [];
  let popupEnv;
  let popupSize;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      methods.push(payload.method);
      if (payload.method === "plugin.pane.open") {
        popupEnv = payload.params.env;
        popupSize = [payload.params.width, payload.params.height];
      }
      const response =
        payload.method === "pane.read"
          ? { result: { read: { text: `Captured ${payload.params.pane_id}` } } }
          : payload.method.startsWith("pane.graphics.")
            ? { error: { code: "unknown_method", message: `unknown method: ${payload.method}` } }
            : { result: { type: "ok" } };
      socket.end(JSON.stringify({ id: payload.id, ...response }) + "\n");
    });
  });
  await listen(server, socketPath);
  try {
    const env = {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdrPath,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
      HERDR_PLUGIN_STATE_DIR: dir,
      HERDR_PLUGIN_CACHE_DIR: dir,
    };
    const launcher = await runNode(path.join(__dirname, "../dist/open-picker.js"), env);
    assert.equal(launcher.code, 0, launcher.stderr);
    assert.deepEqual(popupSize, ["100%", "100%"]);
    const handoff = JSON.parse(readFileSync(popupEnv.HERDR_JUMP_RENDER_STATUS_PATH, "utf8"));
    assert.equal(handoff.snapshots.length, 2);
    assert.equal(handoff.status, undefined);
    const picker = await runNode(path.join(__dirname, "../dist/picker.js"), {
      ...env,
      ...popupEnv,
    });
    assert.equal(picker.code, 0, picker.stderr);
    assert.match(picker.stdout, /w1:p1/);
    assert.match(picker.stdout, /w1:p2/);
    assert.match(picker.stdout, /Captured w1:p1/);
    assert.match(picker.stdout, /Captured w1:p2/);
    assert.equal(methods.filter((method) => method === "pane.read").length, 2);
    assert.equal(methods.at(-1), "pane.focus");
    assert.equal(
      methods.some((method) => method.startsWith("pane.graphics.")),
      false,
    );
    assert.equal(existsSync(popupEnv.HERDR_JUMP_RENDER_STATUS_PATH), false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request sends one newline-delimited pane.focus request", async () => {
  if (process.platform === "win32") {
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  let received;

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      received = chunk;
      const parsed = JSON.parse(chunk.trim());
      socket.write(
        JSON.stringify({
          id: parsed.id,
          result: { type: "pane_focus", focused_pane_id: parsed.params.pane_id },
        }) + "\n",
      );
    });
  });

  await listen(server, socketPath);

  try {
    const response = await request(
      "pane.focus",
      { pane_id: "w1:p2" },
      { socketPath, id: "test-focus" },
    );
    assert.deepEqual(JSON.parse(received.trim()), {
      id: "test-focus",
      method: "pane.focus",
      params: { pane_id: "w1:p2" },
    });
    assert.equal(response.result.focused_pane_id, "w1:p2");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request skips blank frames and accepts a fragmented response", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const requestPayload = JSON.parse(chunk.trim());
      const response = JSON.stringify({ id: requestPayload.id, result: { ok: true } }) + "\n";
      socket.write("\n" + response.slice(0, 8));
      socket.end(response.slice(8));
    });
  });

  await listen(server, socketPath);
  try {
    const response = await request("pane.focus", {}, { socketPath, id: "blank-frame" });
    assert.deepEqual(response.result, { ok: true });
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request times out when the server does not respond", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const server = net.createServer((socket) => socket.resume());

  await listen(server, socketPath);
  try {
    await assert.rejects(
      request("pane.focus", {}, { socketPath, timeoutMs: 20 }),
      /timed out after 20ms/,
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestTimeoutMs clamps values beyond Node's timer limit", () => {
  assert.equal(requestTimeoutMs({ timeoutMs: MAX_TIMEOUT_MS + 1 }, {}), MAX_TIMEOUT_MS);
  assert.equal(requestTimeoutMs({}, { HERDR_REQUEST_TIMEOUT_MS: "0" }), 5000);
});

test("pane graphics requests use independent connections and wait for every response", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      requests.push(payload);
      setTimeout(
        () =>
          socket.end(
            JSON.stringify({ id: payload.id, result: { pane_id: payload.params.pane_id } }) + "\n",
          ),
        5,
      );
    });
  });

  await listen(server, socketPath);
  try {
    const responses = await paneGraphicsSetMany(
      [
        { pane_id: "w1:p1", format: "png", image_width: 1, image_height: 1 },
        { pane_id: "w1:p2", format: "png", image_width: 1, image_height: 1 },
      ],
      { HERDR_SOCKET_PATH: socketPath },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(responses.map((response) => response.result.pane_id).sort(), [
      "w1:p1",
      "w1:p2",
    ]);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleRequests waits for all work before surfacing a failure", async () => {
  const completed = [];
  await assert.rejects(
    settleRequests([
      Promise.reject(new Error("first failed")),
      new Promise((resolve) =>
        setTimeout(() => {
          completed.push("second");
          resolve();
        }, 10),
      ),
    ]),
    /first failed/,
  );
  assert.deepEqual(completed, ["second"]);
});

test("open-picker captures read-only snapshots and removes the handoff when popup opening fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const fakeHerdrPath = path.join(dir, "fake-herdr.js");
  const layoutDonePath = path.join(dir, "layout-done");
  const methods = [];
  let popupOpenedBeforeLayout = false;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      methods.push({ method: payload.method, paneId: payload.params.pane_id });
      if (payload.method === "plugin.pane.open") {
        popupOpenedBeforeLayout = !existsSync(layoutDonePath);
        socket.end(
          JSON.stringify({
            id: payload.id,
            error: { code: "plugin_pane_open_failed", message: "open failed" },
          }) + "\n",
        );
        return;
      }
      const result =
        payload.method === "pane.graphics.info"
          ? { cell_width_px: 9, cell_height_px: 18 }
          : { ok: true };
      socket.end(JSON.stringify({ id: payload.id, result }) + "\n");
    });
  });
  writeFileSync(
    fakeHerdrPath,
    `#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "pane" && args[1] === "layout") {\n  setTimeout(() => {\n    writeFileSync(process.env.TEST_LAYOUT_DONE_PATH, "");\n    process.stdout.write(JSON.stringify({ result: { layout: { focused_pane_id: "w1:p1", zoomed: false, panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 80, height: 24 } }, { pane_id: "w1:p2", rect: { x: 80, y: 0, width: 80, height: 24 } }] } } }));\n  }, 50);\n  return;\n}\nprocess.stderr.write("open failed");\nprocess.exit(1);\n`,
  );
  chmodSync(fakeHerdrPath, 0o755);

  await listen(server, socketPath);
  try {
    const result = await runNode(path.join(__dirname, "..", "dist", "open-picker.js"), {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdrPath,
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p1" }),
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
      TEST_LAYOUT_DONE_PATH: layoutDonePath,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /open failed/);
    assert.equal(popupOpenedBeforeLayout, true);
    assert.deepEqual(
      methods
        .filter((entry) => entry.method === "pane.read")
        .map((entry) => entry.paneId)
        .sort(),
      ["w1:p1", "w1:p2"],
    );
    assert.equal(
      methods.some((entry) => entry.method.startsWith("pane.graphics.")),
      false,
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open-picker reports unavailable jumping through the early popup", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const fakeHerdrPath = path.join(dir, "fake-herdr.js");
  const methods = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      methods.push(payload.method);
      socket.end(JSON.stringify({ id: payload.id, result: { ok: true } }) + "\n");
    });
  });
  writeFileSync(
    fakeHerdrPath,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === "pane" && args[1] === "layout") {\n  process.stdout.write(JSON.stringify({ result: { layout: JSON.parse(process.env.TEST_LAYOUT_JSON) } }));\n  process.exit(0);\n}\nprocess.stderr.write("picker should not open");\nprocess.exit(1);\n`,
  );
  chmodSync(fakeHerdrPath, 0o755);

  const layouts = [
    {
      focused_pane_id: "w1:p1",
      zoomed: true,
      panes: [
        { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 80, height: 24 } },
        { pane_id: "w1:p2", rect: { x: 80, y: 0, width: 80, height: 24 } },
      ],
    },
    {
      focused_pane_id: "w1:p1",
      zoomed: false,
      panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 80, height: 24 } }],
    },
  ];

  await listen(server, socketPath);
  try {
    for (const layout of layouts) {
      methods.length = 0;
      const result = await runNode(path.join(__dirname, "..", "dist", "open-picker.js"), {
        ...process.env,
        HERDR_BIN_PATH: fakeHerdrPath,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p1" }),
        HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
        HERDR_SOCKET_PATH: socketPath,
        TEST_LAYOUT_JSON: JSON.stringify(layout),
      });

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(methods, ["plugin.pane.open"]);
    }
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("picker focuses the selection and clears hints without a finish process", async () => {
  if (process.platform === "win32") {
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-easymotion-"));
  const socketPath = path.join(dir, "herdr.sock");
  const methods = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      methods.push({ method: payload.method, paneId: payload.params.pane_id });
      socket.end(JSON.stringify({ id: payload.id, result: { ok: true } }) + "\n");
    });
  });
  const layout = {
    focused_pane_id: "w1:p1",
    zoomed: false,
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 80, height: 24 } },
      { pane_id: "w1:p2", rect: { x: 80, y: 0, width: 80, height: 24 } },
    ],
  };

  await listen(server, socketPath);
  try {
    const result = await runNode(path.join(__dirname, "..", "dist", "picker.js"), {
      ...process.env,
      HERDR_JUMP_LAYOUT_JSON: JSON.stringify(layout),
      HERDR_JUMP_PRE_RENDERED_PANES_JSON: JSON.stringify(["w1:p1", "w1:p2"]),
      HERDR_JUMP_SOURCE_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: socketPath,
    });

    assert.equal(result.code, 0);
    assert.deepEqual(
      methods.sort((left, right) =>
        `${left.method}:${left.paneId}`.localeCompare(`${right.method}:${right.paneId}`),
      ),
      [
        { method: "pane.read", paneId: "w1:p1" },
        { method: "pane.read", paneId: "w1:p2" },
        { method: "pane.focus", paneId: "w1:p1" },
        { method: "pane.graphics.clear", paneId: "w1:p1" },
        { method: "pane.graphics.clear", paneId: "w1:p2" },
      ].sort((left, right) =>
        `${left.method}:${left.paneId}`.localeCompare(`${right.method}:${right.paneId}`),
      ),
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
