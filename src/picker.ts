#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import readline from "node:readline";

import { buildTargets, createStatus, parsePluginContext, resolvePaneIdFromContext } from "./core";
import type { PaneLayout, PaneTarget, Status } from "./core";
import { createOverlayParams, getCachedCellSize, setCachedCellSize } from "./graphics";
import type { CellSize } from "./graphics";
import {
  HerdrRequestError,
  focusPane,
  paneGraphicsClearMany,
  paneGraphicsInfo,
  paneGraphicsSetMany,
  paneLayout,
} from "./herdr";

interface RenderHintsOptions {
  env?: NodeJS.ProcessEnv;
  sourcePaneId?: string | null;
  controlPaneId?: string | null;
}

interface RenderResult {
  paneIds?: string[];
  status?: Status;
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

function renderStatus(status: Status): void {
  clearScreen();
  process.stdout.write(`${status.title}\n\n`);
  process.stdout.write(`${status.message}\n`);
  if (status.detail) {
    process.stdout.write(`${status.detail}\n`);
  }
  process.stdout.write("\nPress any key to close.");
}

export function graphicsDisabledStatus(): Status {
  return {
    title: "Jump",
    message: "Pane graphics are disabled.",
    detail: "Add [experimental] kitty_graphics = true to your Herdr config, then reload Herdr.",
  };
}

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk: Buffer | string) => resolve(chunk.toString()));
  });
}

function setupTerminal(): () => void {
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

async function waitForDismiss(): Promise<void> {
  if (process.stdin.isTTY) {
    await readKey();
  }
}

export function keyToShortcut(key: string): string | null {
  if (key === "\u0003" || key === "\u001b" || key.toLowerCase() === "q") {
    return null;
  }

  return key.toLowerCase();
}

export async function renderHints(
  targets: readonly PaneTarget[],
  options: RenderHintsOptions = {},
): Promise<string[]> {
  const env = options.env || process.env;
  const sourcePaneId = options.sourcePaneId || null;
  const controlPaneId = options.controlPaneId || env.HERDR_PANE_ID || null;
  const graphicsInfoPaneId = (
    targets.find((target) => target.paneId !== sourcePaneId) || targets[0]
  )?.paneId;
  let sharedInfo: Partial<CellSize> | null = getCachedCellSize(env);
  if (!sharedInfo && graphicsInfoPaneId) {
    sharedInfo = await paneGraphicsInfo(graphicsInfoPaneId, env);
    setCachedCellSize(sharedInfo, env);
  }

  const overlayParams = targets.map((target, index) => {
    const graphicsPaneId =
      target.paneId === sourcePaneId && controlPaneId ? controlPaneId : target.paneId;
    return createOverlayParams({ ...target, paneId: graphicsPaneId }, sharedInfo, index, { env });
  });
  try {
    await paneGraphicsSetMany(
      overlayParams.map((params) => ({ ...params })),
      env,
    );
  } catch (error) {
    await clearHints(
      overlayParams.map((params) => params.pane_id),
      env,
    );
    throw error;
  }

  return overlayParams.map((params) => params.pane_id);
}

export async function clearHints(
  paneIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (paneIds.length === 0) {
    return;
  }

  try {
    await paneGraphicsClearMany(paneIds, env);
  } catch {
    // Clearing is best-effort on exit; a stale hint is less harmful than blocking.
  }
}

export function isGraphicsDisabled(error: unknown): boolean {
  return error instanceof HerdrRequestError && "code" in error && error.code === "feature_disabled";
}

function parseJsonArray(value: string | undefined): string[] {
  const parsed = parsePluginContext(value);
  return (Array.isArray(parsed) ? parsed : []) as string[];
}

async function waitForRenderResult(filePath: string): Promise<RenderResult> {
  const deadline = Date.now() + 5500;

  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(filePath, "utf8")) as RenderResult;
      await rm(filePath, { force: true });
      return result;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return {
          status: {
            title: "Jump",
            message: "Pane hints could not be rendered.",
            detail: error instanceof Error ? error.message : String(error),
          },
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
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

async function main(): Promise<void> {
  const restore = setupTerminal();
  const renderedPaneIds = parseJsonArray(process.env.HERDR_JUMP_PRE_RENDERED_PANES_JSON);
  let hintsCleared = false;

  try {
    let startupStatus = parsePluginContext(
      process.env.HERDR_JUMP_STATUS_JSON,
    ) as unknown as Partial<Status>;
    const renderStatusPath = process.env.HERDR_JUMP_RENDER_STATUS_PATH;
    if (renderStatusPath) {
      const renderResult = await waitForRenderResult(renderStatusPath);
      renderedPaneIds.push(...(renderResult.paneIds || []));
      startupStatus = renderResult.status || startupStatus;
    }
    if (startupStatus.message) {
      renderStatus(startupStatus as Status);
      await waitForDismiss();
      return;
    }

    const context = parsePluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    const sourcePaneId = resolvePaneIdFromContext(context, process.env);
    const snapshotLayout = parsePluginContext(process.env.HERDR_JUMP_LAYOUT_JSON) as PaneLayout;
    const layout = snapshotLayout.panes ? snapshotLayout : paneLayout(sourcePaneId, process.env);
    const targets = buildTargets(layout, new Map(), sourcePaneId, {
      includeCurrent: true,
    });
    const status = createStatus(
      layout,
      layout?.panes && layout.panes.length > 1 ? targets : [],
      sourcePaneId,
    );

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
    const shortcut = keyToShortcut(key);
    const selected = shortcut === null ? undefined : shortcutMap.get(shortcut);

    const [focusResult] = await Promise.allSettled([
      selected ? focusPane(selected.paneId, process.env) : Promise.resolve(),
      clearHints(renderedPaneIds, process.env),
    ]);
    hintsCleared = true;
    if (focusResult.status === "rejected") {
      throw focusResult.reason;
    }
  } finally {
    if (!hintsCleared) {
      await clearHints(renderedPaneIds, process.env);
    }
    clearScreen();
    restore();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    clearScreen();
    showCursor();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
