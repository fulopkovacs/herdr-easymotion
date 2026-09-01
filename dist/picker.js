#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.graphicsDisabledStatus = graphicsDisabledStatus;
exports.keyToShortcut = keyToShortcut;
exports.renderHints = renderHints;
exports.clearHints = clearHints;
exports.isGraphicsDisabled = isGraphicsDisabled;
const promises_1 = require("node:fs/promises");
const node_readline_1 = __importDefault(require("node:readline"));
const core_1 = require("./core");
const graphics_1 = require("./graphics");
const herdr_1 = require("./herdr");
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
        process.stdin.once("data", (chunk) => resolve(chunk.toString()));
    });
}
function setupTerminal() {
    if (!process.stdin.isTTY) {
        return () => { };
    }
    node_readline_1.default.emitKeypressEvents(process.stdin);
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
    let sharedInfo = (0, graphics_1.getCachedCellSize)(env);
    if (!sharedInfo && graphicsInfoPaneId) {
        sharedInfo = await (0, herdr_1.paneGraphicsInfo)(graphicsInfoPaneId, env);
        (0, graphics_1.setCachedCellSize)(sharedInfo, env);
    }
    const overlayParams = targets.map((target, index) => {
        const graphicsPaneId = target.paneId === sourcePaneId && controlPaneId ? controlPaneId : target.paneId;
        return (0, graphics_1.createOverlayParams)({ ...target, paneId: graphicsPaneId }, sharedInfo, index, { env });
    });
    try {
        await (0, herdr_1.paneGraphicsSetMany)(overlayParams.map((params) => ({ ...params })), env);
    }
    catch (error) {
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
        await (0, herdr_1.paneGraphicsClearMany)(paneIds, env);
    }
    catch {
        // Clearing is best-effort on exit; a stale hint is less harmful than blocking.
    }
}
function isGraphicsDisabled(error) {
    return error instanceof herdr_1.HerdrRequestError && "code" in error && error.code === "feature_disabled";
}
function parseJsonArray(value) {
    const parsed = (0, core_1.parsePluginContext)(value);
    return (Array.isArray(parsed) ? parsed : []);
}
async function waitForRenderResult(filePath) {
    const deadline = Date.now() + 5500;
    while (Date.now() < deadline) {
        try {
            const result = JSON.parse(await (0, promises_1.readFile)(filePath, "utf8"));
            await (0, promises_1.rm)(filePath, { force: true });
            return result;
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                return {
                    status: {
                        title: "Jump",
                        message: "Pane hints could not be rendered.",
                        detail: error instanceof Error ? error.message : String(error),
                    },
                };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }
    return {
        status: {
            title: "Jump",
            message: "Pane hints timed out.",
            detail: "Herdr did not finish rendering pane hints.",
        },
    };
}
async function main() {
    const restore = setupTerminal();
    const renderedPaneIds = parseJsonArray(process.env.HERDR_JUMP_PRE_RENDERED_PANES_JSON);
    let hintsCleared = false;
    try {
        let startupStatus = (0, core_1.parsePluginContext)(process.env.HERDR_JUMP_STATUS_JSON);
        const renderStatusPath = process.env.HERDR_JUMP_RENDER_STATUS_PATH;
        if (renderStatusPath) {
            const renderResult = await waitForRenderResult(renderStatusPath);
            renderedPaneIds.push(...(renderResult.paneIds || []));
            startupStatus = renderResult.status || startupStatus;
        }
        if (startupStatus.message) {
            renderStatus(startupStatus);
            await waitForDismiss();
            return;
        }
        const context = (0, core_1.parsePluginContext)(process.env.HERDR_PLUGIN_CONTEXT_JSON);
        const sourcePaneId = (0, core_1.resolvePaneIdFromContext)(context, process.env);
        const snapshotLayout = (0, core_1.parsePluginContext)(process.env.HERDR_JUMP_LAYOUT_JSON);
        const layout = snapshotLayout.panes ? snapshotLayout : (0, herdr_1.paneLayout)(sourcePaneId, process.env);
        const targets = (0, core_1.buildTargets)(layout, new Map(), sourcePaneId, {
            includeCurrent: true,
        });
        const status = (0, core_1.createStatus)(layout, layout?.panes && layout.panes.length > 1 ? targets : [], sourcePaneId);
        if (status) {
            renderStatus(status);
            await waitForDismiss();
            return;
        }
        try {
            if (renderedPaneIds.length === 0) {
                renderedPaneIds.push(...(await renderHints(targets, {
                    env: process.env,
                    sourcePaneId,
                })));
            }
        }
        catch (error) {
            if (isGraphicsDisabled(error)) {
                renderStatus(graphicsDisabledStatus());
                await waitForDismiss();
                return;
            }
            throw error;
        }
        const shortcutMap = new Map(targets.map((target) => [target.shortcut, target]));
        const key = process.stdin.isTTY ? await readKey() : targets[0].shortcut;
        const shortcut = keyToShortcut(key);
        const selected = shortcut === null ? undefined : shortcutMap.get(shortcut);
        const [focusResult] = await Promise.allSettled([
            selected ? (0, herdr_1.focusPane)(selected.paneId, process.env) : Promise.resolve(),
            clearHints(renderedPaneIds, process.env),
        ]);
        hintsCleared = true;
        if (focusResult.status === "rejected") {
            throw focusResult.reason;
        }
    }
    finally {
        if (!hintsCleared) {
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
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
