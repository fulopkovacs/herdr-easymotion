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
    const statusPath = renderStatusPath(env);
    const paneEnv = {
        HERDR_JUMP_RENDER_STATUS_PATH: statusPath,
    };
    if (sourcePaneId) {
        paneEnv.HERDR_JUMP_SOURCE_PANE_ID = sourcePaneId;
    }
    // Open the modal before discovering and rendering the layout so it captures follow-up input.
    const openPromise = (0, herdr_1.openPluginPane)({
        plugin_id: pluginId,
        entrypoint: "picker",
        placement: "popup",
        width: "80%",
        height: "80%",
        env: paneEnv,
        focus: true,
    }, env).then(() => null, (error) => error);
    const renderPromise = (0, herdr_1.paneLayoutAsync)(sourcePaneId, env)
        .then(async (layout) => {
        const targets = (0, core_1.buildTargets)(layout, new Map(), sourcePaneId, {
            includeCurrent: true,
        });
        const status = (0, core_1.createStatus)(layout, layout?.panes && layout.panes.length > 1 ? targets : [], sourcePaneId);
        if (status) {
            return { layout, status };
        }
        try {
            return {
                layout,
                ...(await (0, picker_1.renderPickerHints)(targets, { env, sourcePaneId })),
            };
        }
        catch (error) {
            return {
                layout,
                status: {
                    title: "Jump",
                    message: "Pane hints could not be rendered.",
                    detail: error instanceof Error ? error.message : String(error),
                },
            };
        }
    })
        .catch((error) => ({
        status: {
            title: "Jump",
            message: "The pane layout could not be loaded.",
            detail: error instanceof Error ? error.message : String(error),
        },
    }))
        .then((result) => {
        writeRenderResult(statusPath, result);
        return result;
    });
    const [openError, result] = await Promise.all([openPromise, renderPromise]);
    if (openError) {
        await (0, picker_1.clearHints)(result.paneIds || [], env);
        (0, node_fs_1.rmSync)(statusPath, { force: true });
        (0, node_fs_1.rmSync)(`${statusPath}.tmp`, { force: true });
        throw openError;
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
