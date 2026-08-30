#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("./core");
const herdr_1 = require("./herdr");
const picker_1 = require("./picker");
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
    let renderedPaneIds = [];
    let startupStatus = null;
    try {
        renderedPaneIds = await (0, picker_1.renderHints)(targets, { env, sourcePaneId });
    }
    catch (error) {
        if ((0, picker_1.isGraphicsDisabled)(error)) {
            startupStatus = (0, picker_1.graphicsDisabledStatus)();
        }
        else {
            throw error;
        }
    }
    const args = [
        "plugin",
        "pane",
        "open",
        "--plugin",
        pluginId,
        "--entrypoint",
        "picker",
        "--placement",
        "popup",
        "--width",
        "0",
        "--height",
        "0",
        "--focus",
        "--env",
        `HERDR_JUMP_LAYOUT_JSON=${JSON.stringify(layout)}`,
        "--env",
        `HERDR_JUMP_PRE_RENDERED_PANES_JSON=${JSON.stringify(renderedPaneIds)}`,
    ];
    if (startupStatus) {
        args.push("--env", `HERDR_JUMP_STATUS_JSON=${JSON.stringify(startupStatus)}`);
    }
    if (sourcePaneId) {
        args.push("--env", `HERDR_JUMP_SOURCE_PANE_ID=${sourcePaneId}`);
    }
    try {
        (0, herdr_1.runHerdr)(args, { env });
    }
    catch (error) {
        await (0, picker_1.clearHints)(renderedPaneIds, env);
        throw error;
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
