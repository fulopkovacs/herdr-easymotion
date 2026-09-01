#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const core_1 = require("./core");
const herdr_1 = require("./herdr");
const picker_1 = require("./picker");
function renderStatusPath(env) {
    const directory = env.HERDR_PLUGIN_STATE_DIR || env.TMPDIR || node_os_1.default.tmpdir();
    (0, node_fs_1.mkdirSync)(directory, { recursive: true });
    return node_path_1.default.join(directory, `render-${process.pid}-${Date.now()}.json`);
}
function writeRenderResult(filePath, result) {
    const temporaryPath = `${filePath}.tmp`;
    (0, node_fs_1.writeFileSync)(temporaryPath, JSON.stringify(result));
    (0, node_fs_1.renameSync)(temporaryPath, filePath);
}
async function main() {
    const env = process.env;
    const pluginId = env.HERDR_PLUGIN_ID || "com.elliotekj.herdr-easymotion";
    const context = (0, core_1.parsePluginContext)(env.HERDR_PLUGIN_CONTEXT_JSON);
    const sourcePaneId = (0, core_1.resolvePaneIdFromContext)(context, env);
    const layout = (0, herdr_1.paneLayout)(sourcePaneId, env);
    const targets = (0, core_1.buildTargets)(layout, new Map(), sourcePaneId, {
        includeCurrent: true,
    });
    const status = (0, core_1.createStatus)(layout, layout?.panes && layout.panes.length > 1 ? targets : [], sourcePaneId);
    if (status) {
        return;
    }
    const statusPath = renderStatusPath(env);
    const paneEnv = {
        HERDR_JUMP_LAYOUT_JSON: JSON.stringify(layout),
        HERDR_JUMP_RENDER_STATUS_PATH: statusPath,
    };
    if (sourcePaneId) {
        paneEnv.HERDR_JUMP_SOURCE_PANE_ID = sourcePaneId;
    }
    // The picker waits for the atomic status file while Herdr opens it and renders in parallel.
    const openPromise = (0, herdr_1.openPluginPane)({
        plugin_id: pluginId,
        entrypoint: "picker",
        placement: "popup",
        env: paneEnv,
        focus: true,
    }, env);
    const renderPromise = (0, picker_1.renderHints)(targets, { env, sourcePaneId })
        .then((paneIds) => ({ paneIds }))
        .catch((error) => ({
        status: (0, picker_1.isGraphicsDisabled)(error)
            ? (0, picker_1.graphicsDisabledStatus)()
            : {
                title: "Jump",
                message: "Pane hints could not be rendered.",
                detail: error instanceof Error ? error.message : String(error),
            },
    }))
        .then((result) => {
        writeRenderResult(statusPath, result);
        return result;
    });
    try {
        await openPromise;
    }
    catch (error) {
        const result = await renderPromise;
        await (0, picker_1.clearHints)(result.paneIds || [], env);
        (0, node_fs_1.rmSync)(statusPath, { force: true });
        (0, node_fs_1.rmSync)(`${statusPath}.tmp`, { force: true });
        throw error;
    }
    await renderPromise;
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
