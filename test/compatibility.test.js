"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { mkdtempSync, rmSync } = require("node:fs");
const { renderPickerHints, clearHints } = require("../dist/picker");
const { setCachedCellSize } = require("../dist/graphics");

const targets = [
  { shortcut: "1", paneId: "w1:p1", rect: { width: 80, height: 24 } },
  { shortcut: "2", paneId: "w1:p2", rect: { width: 80, height: 24 } },
];

async function withServer(handler, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easymotion-api-"));
  const socketPath = path.join(dir, "api.sock");
  const methods = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const payload = JSON.parse(chunk.trim());
      methods.push(payload.method);
      socket.end(JSON.stringify({ id: payload.id, ...handler(payload) }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await run(
      {
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PLUGIN_CACHE_DIR: dir,
        HERDR_EASYMOTION_APPEARANCE: "dark",
      },
      methods,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const code of ["unknown_method", "feature_disabled"]) {
  test(`${code} falls back to terminal hints without a config change`, async () => {
    await withServer(
      () => ({ error: { code, message: "graphics unavailable" } }),
      async (env, methods) => {
        assert.deepEqual(await renderPickerHints(targets, { env }), { textPicker: true });
        assert.deepEqual(methods, ["pane.graphics.info"]);
      },
    );
  });
}

test("cached cell dimensions do not hide unsupported graphics.set", async () => {
  await withServer(
    () => ({ error: { code: "unknown_method", message: "unknown method" } }),
    async (env, methods) => {
      setCachedCellSize({ cell_width_px: 9, cell_height_px: 18 }, env);
      assert.deepEqual(await renderPickerHints(targets, { env }), { textPicker: true });
      assert.equal(methods.filter((method) => method === "pane.graphics.set").length, 2);
      assert.equal(methods.filter((method) => method === "pane.graphics.clear").length, 2);
    },
  );
});

test("supported servers retain graphical hints and cleanup", async () => {
  await withServer(
    ({ method }) => ({
      result: method === "pane.graphics.info" ? { cell_width_px: 9, cell_height_px: 18 } : {},
    }),
    async (env, methods) => {
      const result = await renderPickerHints(targets, { env });
      assert.deepEqual(result, { paneIds: ["w1:p1", "w1:p2"] });
      await clearHints(result.paneIds, env);
      assert.equal(methods.filter((method) => method === "pane.graphics.clear").length, 2);
    },
  );
});

test("other API failures are reported rather than masked by fallback", async () => {
  await withServer(
    () => ({ error: { code: "pane_not_found", message: "closed pane" } }),
    async (env) => {
      await assert.rejects(renderPickerHints(targets, { env }), /pane_not_found/);
    },
  );
});
