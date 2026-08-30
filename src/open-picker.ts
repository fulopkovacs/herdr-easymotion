#!/usr/bin/env node

import { buildTargets, createStatus, parsePluginContext, resolvePaneIdFromContext } from "./core";
import { paneLayout, runHerdr } from "./herdr";
import { clearHints, graphicsDisabledStatus, isGraphicsDisabled, renderHints } from "./picker";

async function main(): Promise<void> {
  const env = process.env;
  const pluginId = env.HERDR_PLUGIN_ID || "com.elliotekj.herdr-easymotion";
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const sourcePaneId = resolvePaneIdFromContext(context, env);
  const layout = paneLayout(sourcePaneId, env);
  const targets = buildTargets(layout, new Map(), sourcePaneId, {
    includeCurrent: true,
  });
  const status = createStatus(
    layout,
    layout?.panes && layout.panes.length > 1 ? targets : [],
    sourcePaneId,
  );
  if (status) {
    return;
  }

  let renderedPaneIds: string[] = [];
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
