#!/usr/bin/env node
"use strict";

const { buildTargets, createStatus, parsePluginContext, resolvePaneIdFromContext } = require("./core");
const { paneLayout, runHerdr } = require("./herdr");
const { clearHints, graphicsDisabledStatus, isGraphicsDisabled, renderHints } = require("./picker");

async function main() {
  const env = process.env;
  const pluginId = env.HERDR_PLUGIN_ID || "com.elliotekj.herdr-easymotion";
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const sourcePaneId = resolvePaneIdFromContext(context, env);
  const layout = paneLayout(sourcePaneId, env);
  const targets = buildTargets(layout, new Map(), sourcePaneId, { includeCurrent: true });
  const status = createStatus(layout, layout?.panes?.length > 1 ? targets : [], sourcePaneId);
  if (status) {
    return;
  }

  let renderedPaneIds = [];
  let startupStatus = null;

  try {
    renderedPaneIds = await renderHints(targets, { env, sourcePaneId });
  } catch (error) {
    if (isGraphicsDisabled(error)) {
      startupStatus = graphicsDisabledStatus();
    } else {
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
    runHerdr(args, { env });
  } catch (error) {
    await clearHints(renderedPaneIds, env);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
