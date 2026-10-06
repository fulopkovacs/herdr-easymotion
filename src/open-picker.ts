#!/usr/bin/env node

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTargets, createStatus, parsePluginContext, resolvePaneIdFromContext } from "./core";
import type { PaneLayout, Status } from "./core";
import { appearanceForEnv } from "./graphics";
import { openPluginPane, paneLayoutAsync } from "./herdr";
import { captureSnapshots } from "./snapshot";
import type { PaneSnapshot } from "./snapshot";

interface RenderResult {
  snapshots?: PaneSnapshot[];
  layout?: PaneLayout;
  status?: Status;
  appearance?: "light" | "dark";
}

function renderStatusPath(env: NodeJS.ProcessEnv): string {
  const directory = env.HERDR_PLUGIN_STATE_DIR || env.TMPDIR || os.tmpdir();
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `render-${process.pid}-${Date.now()}.json`);
}

function writeRenderResult(filePath: string, result: RenderResult): void {
  const temporaryPath = `${filePath}.tmp`;
  // Snapshots can contain credentials or other private terminal contents.
  writeFileSync(temporaryPath, JSON.stringify(result), { mode: 0o600, flag: "wx" });
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
      width: "100%",
      height: "100%",
      env: paneEnv,
      focus: true,
    },
    env,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  // Detecting the system appearance can spawn `defaults`; doing it here, while
  // the popup starts, keeps that off the picker's path to its first frame.
  const appearancePromise = appearanceForEnv(env).catch(() => undefined);
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
          snapshots: await captureSnapshots(targets, env),
        };
      } catch (error) {
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
    .catch((error: unknown): RenderResult => ({
      status: {
        title: "Jump",
        message: "The pane layout could not be loaded.",
        detail: error instanceof Error ? error.message : String(error),
      },
    }))
    .then(async (result) => {
      writeRenderResult(statusPath, { ...result, appearance: await appearancePromise });
      return result;
    });

  const [openError] = await Promise.all([openPromise, renderPromise]);
  if (openError) {
    rmSync(statusPath, { force: true });
    rmSync(`${statusPath}.tmp`, { force: true });
    throw openError;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
