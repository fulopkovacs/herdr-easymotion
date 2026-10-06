#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.graphicsDisabledStatus = graphicsDisabledStatus;
exports.readKey = readKey;
exports.keyToSelection = keyToSelection;
exports.copyPaneId = copyPaneId;
exports.renderHints = renderHints;
exports.clearHints = clearHints;
exports.isGraphicsDisabled = isGraphicsDisabled;
exports.renderPickerHints = renderPickerHints;
const promises_1 = require("node:fs/promises");
const core_1 = require("./core");
const graphics_1 = require("./graphics");
const herdr_1 = require("./herdr");
const snapshot_1 = require("./snapshot");
const SHIFTED_NUMBER_KEYS = "!@#$%^&*(";
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
function readKey(input = process.stdin) {
    return new Promise((resolve) => {
        input.once("data", (chunk) => resolve(chunk.toString()));
    });
}
function setupTerminal() {
    if (!process.stdin.isTTY) {
        return { firstKey: null, restore: () => { } };
    }
    process.stdin.setRawMode(true);
    const firstKey = readKey();
    process.stdin.resume();
    hideCursor();
    clearScreen();
    return {
        firstKey,
        restore: () => {
            process.stdout.write("\x1b[0m\x1b[?7h");
            showCursor();
            process.stdin.setRawMode(false);
            process.stdin.pause();
        },
    };
}
async function waitForDismiss(firstKey) {
    if (firstKey) {
        await firstKey;
    }
}
function keyToSelection(key) {
    if (key === "\u0003" || key === "\u001b" || key.toLowerCase() === "q") {
        return null;
    }
    const shiftedNumberIndex = SHIFTED_NUMBER_KEYS.indexOf(key);
    return {
        shortcut: shiftedNumberIndex === -1 ? key.toLowerCase() : String(shiftedNumberIndex + 1),
        copyPaneId: shiftedNumberIndex !== -1,
    };
}
function copyPaneId(paneId, output = process.stdout) {
    output.write(`\x1b]52;c;${Buffer.from(paneId).toString("base64")}\x07`);
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
async function renderPickerHints(targets, options = {}) {
    try {
        return { paneIds: await renderHints(targets, options) };
    }
    catch (error) {
        if (isGraphicsDisabled(error) ||
            (error instanceof herdr_1.HerdrRequestError && error.code === "unknown_method")) {
            return { textPicker: true };
        }
        throw error;
    }
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
    const { firstKey, restore } = setupTerminal();
    const renderedPaneIds = parseJsonArray(process.env.HERDR_JUMP_PRE_RENDERED_PANES_JSON);
    let coordinatedLayout;
    let coordinatedSnapshots;
    let renderEnv = process.env;
    let hintsCleared = false;
    let active = true;
    let resizeGeneration = 0;
    let resizeTimer;
    let onResize;
    try {
        let startupStatus = (0, core_1.parsePluginContext)(process.env.HERDR_JUMP_STATUS_JSON);
        const renderStatusPath = process.env.HERDR_JUMP_RENDER_STATUS_PATH;
        if (renderStatusPath) {
            const renderResult = await waitForRenderResult(renderStatusPath);
            renderedPaneIds.push(...(renderResult.paneIds || []));
            startupStatus = renderResult.status || startupStatus;
            coordinatedLayout = renderResult.layout;
            coordinatedSnapshots = renderResult.snapshots;
            if (renderResult.appearance && !process.env.HERDR_EASYMOTION_APPEARANCE) {
                renderEnv = { ...process.env, HERDR_EASYMOTION_APPEARANCE: renderResult.appearance };
            }
        }
        if (startupStatus.message) {
            renderStatus(startupStatus);
            await waitForDismiss(firstKey);
            return;
        }
        const context = (0, core_1.parsePluginContext)(process.env.HERDR_PLUGIN_CONTEXT_JSON);
        const sourcePaneId = (0, core_1.resolvePaneIdFromContext)(context, process.env);
        const snapshotLayout = coordinatedLayout || (0, core_1.parsePluginContext)(process.env.HERDR_JUMP_LAYOUT_JSON);
        const layout = snapshotLayout.panes ? snapshotLayout : (0, herdr_1.paneLayout)(sourcePaneId, process.env);
        const targets = (0, core_1.buildTargets)(layout, new Map(), sourcePaneId, {
            includeCurrent: true,
        });
        const status = (0, core_1.createStatus)(layout, layout?.panes && layout.panes.length > 1 ? targets : [], sourcePaneId);
        if (status) {
            renderStatus(status);
            await waitForDismiss(firstKey);
            return;
        }
        const drawSnapshot = (currentLayout, currentTargets, snapshots) => {
            process.stdout.write((0, snapshot_1.renderSnapshot)(currentLayout, currentTargets, snapshots, process.stdout.columns ||
                Math.max(1, ...targets.map((target) => target.rect.x + target.rect.width)) - 3, process.stdout.rows ||
                Math.max(1, ...targets.map((target) => target.rect.y + target.rect.height)) - 2, renderEnv));
        };
        drawSnapshot(layout, targets, coordinatedSnapshots || (await (0, snapshot_1.captureSnapshots)(targets)));
        onResize = () => {
            const generation = ++resizeGeneration;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                void (async () => {
                    const currentLayout = await (0, herdr_1.paneLayoutAsync)(sourcePaneId);
                    if (!currentLayout || !active || generation !== resizeGeneration)
                        return;
                    const byId = new Map((0, core_1.buildTargets)(currentLayout, new Map(), sourcePaneId, { includeCurrent: true }).map((target) => [target.paneId, target]));
                    // Keep the original shortcut-to-pane mapping, even if topology changes.
                    const currentTargets = targets.flatMap((target) => {
                        const current = byId.get(target.paneId);
                        return current ? [{ ...current, shortcut: target.shortcut }] : [];
                    });
                    const snapshots = await (0, snapshot_1.captureSnapshots)(currentTargets);
                    if (active && generation === resizeGeneration)
                        drawSnapshot(currentLayout, currentTargets, snapshots);
                })().catch(() => {
                    // A failed resize refresh leaves the last snapshot and mapping intact.
                });
            }, 60);
        };
        process.stdout.on("resize", onResize);
        const shortcutMap = new Map(targets.map((target) => [target.shortcut, target]));
        const key = firstKey ? await firstKey : targets[0].shortcut;
        const selection = keyToSelection(key);
        const selected = selection ? shortcutMap.get(selection.shortcut) : undefined;
        const [selectionResult] = await Promise.allSettled([
            selected
                ? selection?.copyPaneId
                    ? Promise.resolve(copyPaneId(selected.paneId))
                    : (0, herdr_1.focusPane)(selected.paneId, process.env)
                : Promise.resolve(),
            clearHints(renderedPaneIds, process.env),
        ]);
        hintsCleared = true;
        if (selectionResult.status === "rejected") {
            throw selectionResult.reason;
        }
    }
    finally {
        active = false;
        clearTimeout(resizeTimer);
        if (onResize)
            process.stdout.off("resize", onResize);
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
