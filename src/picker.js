#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  buildTargets,
  createStatus,
  parsePluginContext,
  resolvePaneIdFromContext,
} = require("./core");
const { createOverlayParams, getCachedCellSize, setCachedCellSize } = require("./graphics");
const {
  HerdrRequestError,
  paneGraphicsClearMany,
  paneGraphicsInfo,
  paneGraphicsSetMany,
  paneLayout,
} = require("./herdr");

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function hideCursor() {
  process.stdout.write("\x1b[?25l");
}

function showCursor() {
  process.stdout.write("\x1b[?25h");
}

function renderStatus(status) {
  clearScreen();
  process.stdout.write(`${status.title}\n\n`);
  process.stdout.write(`${status.message}\n`);
  if (status.detail) {
    process.stdout.write(`${status.detail}\n`);
  }
  process.stdout.write("\nPress any key to close.");
}

function graphicsDisabledStatus() {
  return {
    title: "Jump",
    message: "Pane graphics are disabled.",
    detail: "Add [experimental] kitty_graphics = true to your Herdr config, then reload Herdr.",
  };
}

function readKey() {
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk) => resolve(chunk.toString("utf8")));
  });
}

function setupTerminal() {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursor();
  clearScreen();

  return () => {
    showCursor();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

async function waitForDismiss() {
  if (process.stdin.isTTY) {
    await readKey();
  }
}

function keyToShortcut(key) {
  if (key === "\u0003" || key === "\u001b" || key.toLowerCase() === "q") {
    return null;
  }

  return key.toLowerCase();
}

async function renderHints(targets, options = {}) {
  const env = options.env || process.env;
  const sourcePaneId = options.sourcePaneId || null;
  const controlPaneId = options.controlPaneId || env.HERDR_PANE_ID || null;
  const graphicsInfoPaneId = (targets.find((target) => target.paneId !== sourcePaneId) || targets[0])?.paneId;
  let sharedInfo = getCachedCellSize(env);
  if (!sharedInfo && graphicsInfoPaneId) {
    sharedInfo = await paneGraphicsInfo(graphicsInfoPaneId, env);
    setCachedCellSize(sharedInfo, env);
  }

  const overlayParams = targets.map((target, index) => {
    const graphicsPaneId = target.paneId === sourcePaneId && controlPaneId ? controlPaneId : target.paneId;
    return createOverlayParams({ ...target, paneId: graphicsPaneId }, sharedInfo, index, { env });
  });
  try {
    await paneGraphicsSetMany(overlayParams, env);
  } catch (error) {
    await clearHints(overlayParams.map((params) => params.pane_id), env);
    throw error;
  }

  return overlayParams.map((params) => params.pane_id);
}

async function clearHints(paneIds, env = process.env) {
  if (paneIds.length === 0) {
    return;
  }

  try {
    await paneGraphicsClearMany(paneIds, env);
  } catch {
    // Clearing is best-effort on exit; a stale hint is less harmful than blocking.
  }
}

function isGraphicsDisabled(error) {
  return error instanceof HerdrRequestError && error.code === "feature_disabled";
}

function parseJsonArray(value) {
  const parsed = parsePluginContext(value);
  return Array.isArray(parsed) ? parsed : [];
}

function scheduleFinish(targetPaneId, paneIds, env = process.env) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "finish-selection.js"), targetPaneId || "", JSON.stringify([...new Set(paneIds)])],
    {
      cwd: path.join(__dirname, ".."),
      detached: true,
      env,
      stdio: "ignore",
    },
  );
  child.unref();
}

async function main() {
  const restore = setupTerminal();
  const renderedPaneIds = parseJsonArray(process.env.HERDR_JUMP_PRE_RENDERED_PANES_JSON);
  let finishScheduled = false;

  try {
    const startupStatus = parsePluginContext(process.env.HERDR_JUMP_STATUS_JSON);
    if (startupStatus?.message) {
      renderStatus(startupStatus);
      await waitForDismiss();
      return;
    }

    const context = parsePluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    const sourcePaneId = resolvePaneIdFromContext(context, process.env);
    const snapshotLayout = parsePluginContext(process.env.HERDR_JUMP_LAYOUT_JSON);
    const layout = snapshotLayout?.panes ? snapshotLayout : paneLayout(sourcePaneId, process.env);
    const targets = buildTargets(layout, new Map(), sourcePaneId, { includeCurrent: true });
    const status = createStatus(layout, layout?.panes?.length > 1 ? targets : [], sourcePaneId);

    if (status) {
      renderStatus(status);
      await waitForDismiss();
      return;
    }

    try {
      if (renderedPaneIds.length === 0) {
        renderedPaneIds.push(
          ...(await renderHints(targets, {
            env: process.env,
            sourcePaneId,
          })),
        );
      }
    } catch (error) {
      if (isGraphicsDisabled(error)) {
        renderStatus(graphicsDisabledStatus());
        await waitForDismiss();
        return;
      }
      throw error;
    }

    const shortcutMap = new Map(targets.map((target) => [target.shortcut, target]));
    const key = process.stdin.isTTY ? await readKey() : targets[0].shortcut;
    const selected = shortcutMap.get(keyToShortcut(key));

    scheduleFinish(selected?.paneId || "", renderedPaneIds, process.env);
    finishScheduled = true;
  } finally {
    if (!finishScheduled) {
      await clearHints(renderedPaneIds, process.env);
    }
    clearScreen();
    restore();
  }
}

if (require.main === module) {
  main().catch((error) => {
    clearScreen();
    showCursor();
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  clearHints,
  graphicsDisabledStatus,
  isGraphicsDisabled,
  keyToShortcut,
  renderHints,
  scheduleFinish,
};
