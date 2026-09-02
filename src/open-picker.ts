#!/usr/bin/env node

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTargets, createStatus, parsePluginContext, resolvePaneIdFromContext } from "./core";
import type { PaneLayout, Status } from "./core";
import { openPluginPane, paneLayoutAsync } from "./herdr";
import { clearHints, graphicsDisabledStatus, isGraphicsDisabled, renderHints } from "./picker";

interface RenderResult {
  paneIds?: string[];
  layout?: PaneLayout;
  status?: Status;
}

function renderStatusPath(env: NodeJS.ProcessEnv): string {
  const directory = env.HERDR_PLUGIN_STATE_DIR || env.TMPDIR || os.tmpdir();
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `render-${process.pid}-${Date.now()}.json`);
}

function writeRenderResult(filePath: string, result: RenderResult): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(result));
  renameSync(temporaryPath, filePath);
}

async function main(): Promise<void> {
  const env = process.env;
  const pluginId = env.HERDR_PLUGIN_ID || "com.elliotekj.herdr-easymotion";
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const sourcePaneId = resolvePaneIdFromContext(context, env);
  const statusPath = renderStatusPath(env);
  const paneEnv: Record<string, string> = {
    HERDR_JUMP_RENDER_STATUS_PATH: statusPath,
  };
  if (sourcePaneId) {
    paneEnv.HERDR_JUMP_SOURCE_PANE_ID = sourcePaneId;
  }

  // Open the modal before discovering and rendering the layout so it captures follow-up input.
  const openPromise = openPluginPane(
    {
      plugin_id: pluginId,
      entrypoint: "picker",
      placement: "popup",
      env: paneEnv,
      focus: true,
    },
    env,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  const renderPromise = paneLayoutAsync(sourcePaneId, env)
    .then(async (layout): Promise<RenderResult> => {
      const targets = buildTargets(layout, new Map(), sourcePaneId, {
        includeCurrent: true,
      });
      const status = createStatus(
        layout,
        layout?.panes && layout.panes.length > 1 ? targets : [],
        sourcePaneId,
      );
      if (status) {
        return { layout, status };
      }

      try {
        return {
          layout,
          paneIds: await renderHints(targets, { env, sourcePaneId }),
        };
      } catch (error) {
        return {
          layout,
          status: isGraphicsDisabled(error)
            ? graphicsDisabledStatus()
            : {
                title: "Jump",
                message: "Pane hints could not be rendered.",
                detail: error instanceof Error ? error.message : String(error),
              },
        };
      }
    })
    .catch((error: unknown): RenderResult => ({
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
    await clearHints(result.paneIds || [], env);
    rmSync(statusPath, { force: true });
    rmSync(`${statusPath}.tmp`, { force: true });
    throw openError;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
