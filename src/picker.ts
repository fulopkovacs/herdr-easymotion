#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";

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
  paneLayoutAsync,
} from "./herdr";
import { captureSnapshots, renderSnapshot } from "./snapshot";
import type { PaneSnapshot } from "./snapshot";

interface RenderHintsOptions {
  env?: NodeJS.ProcessEnv;
  sourcePaneId?: string | null;
  controlPaneId?: string | null;
}

interface RenderResult {
  paneIds?: string[];
  textPicker?: boolean;
  snapshots?: PaneSnapshot[];
  layout?: PaneLayout;
  status?: Status;
  appearance?: "light" | "dark";
}

interface TerminalSession {
  firstKey: Promise<string> | null;
  restore: () => void;
}

interface PaneSelection {
  shortcut: string;
  copyPaneId: boolean;
}

const SHIFTED_NUMBER_KEYS = "!@#$%^&*(";

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

export function readKey(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve) => {
    input.once("data", (chunk: Buffer | string) => resolve(chunk.toString()));
  });
}

function setupTerminal(): TerminalSession {
  if (!process.stdin.isTTY) {
    return { firstKey: null, restore: () => {} };
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

async function waitForDismiss(firstKey: Promise<string> | null): Promise<void> {
  if (firstKey) {
    await firstKey;
  }
}

export function keyToSelection(key: string): PaneSelection | null {
  if (key === "\u0003" || key === "\u001b" || key.toLowerCase() === "q") {
    return null;
  }

  const shiftedNumberIndex = SHIFTED_NUMBER_KEYS.indexOf(key);
  return {
    shortcut: shiftedNumberIndex === -1 ? key.toLowerCase() : String(shiftedNumberIndex + 1),
    copyPaneId: shiftedNumberIndex !== -1,
  };
}

export function copyPaneId(
  paneId: string,
  output: Pick<NodeJS.WritableStream, "write"> = process.stdout,
): void {
  output.write(`\x1b]52;c;${Buffer.from(paneId).toString("base64")}\x07`);
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

export async function renderPickerHints(
  targets: readonly PaneTarget[],
  options: RenderHintsOptions = {},
): Promise<Pick<RenderResult, "paneIds" | "textPicker">> {
  try {
    return { paneIds: await renderHints(targets, options) };
  } catch (error) {
    if (
      isGraphicsDisabled(error) ||
      (error instanceof HerdrRequestError && error.code === "unknown_method")
    ) {
      return { textPicker: true };
    }
    throw error;
  }
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
  const { firstKey, restore } = setupTerminal();
  const renderedPaneIds = parseJsonArray(process.env.HERDR_JUMP_PRE_RENDERED_PANES_JSON);
  let coordinatedLayout: PaneLayout | undefined;
  let coordinatedSnapshots: PaneSnapshot[] | undefined;
  let renderEnv = process.env;
  let hintsCleared = false;
  let active = true;
  let resizeGeneration = 0;
  let resizeTimer: NodeJS.Timeout | undefined;
  let onResize: (() => void) | undefined;

  try {
    let startupStatus = parsePluginContext(
      process.env.HERDR_JUMP_STATUS_JSON,
    ) as unknown as Partial<Status>;
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
      renderStatus(startupStatus as Status);
      await waitForDismiss(firstKey);
      return;
    }

    const context = parsePluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    const sourcePaneId = resolvePaneIdFromContext(context, process.env);
    const snapshotLayout =
      coordinatedLayout || (parsePluginContext(process.env.HERDR_JUMP_LAYOUT_JSON) as PaneLayout);
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
      await waitForDismiss(firstKey);
      return;
    }

    const drawSnapshot = (
      currentLayout: PaneLayout,
      currentTargets: readonly PaneTarget[],
      snapshots: readonly PaneSnapshot[],
    ): void => {
      process.stdout.write(
        renderSnapshot(
          currentLayout,
          currentTargets,
          snapshots,
          process.stdout.columns ||
            Math.max(1, ...targets.map((target) => target.rect.x + target.rect.width)) - 3,
          process.stdout.rows ||
            Math.max(1, ...targets.map((target) => target.rect.y + target.rect.height)) - 2,
          renderEnv,
        ),
      );
    };
    drawSnapshot(layout!, targets, coordinatedSnapshots || (await captureSnapshots(targets)));
    onResize = () => {
      const generation = ++resizeGeneration;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void (async () => {
          const currentLayout = await paneLayoutAsync(sourcePaneId);
          if (!currentLayout || !active || generation !== resizeGeneration) return;
          const byId = new Map(
            buildTargets(currentLayout, new Map(), sourcePaneId, { includeCurrent: true }).map(
              (target) => [target.paneId, target],
            ),
          );
          // Keep the original shortcut-to-pane mapping, even if topology changes.
          const currentTargets = targets.flatMap((target) => {
            const current = byId.get(target.paneId);
            return current ? [{ ...current, shortcut: target.shortcut }] : [];
          });
          const snapshots = await captureSnapshots(currentTargets);
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
          : focusPane(selected.paneId, process.env)
        : Promise.resolve(),
      clearHints(renderedPaneIds, process.env),
    ]);
    hintsCleared = true;
    if (selectionResult.status === "rejected") {
      throw selectionResult.reason;
    }
  } finally {
    active = false;
    clearTimeout(resizeTimer);
    if (onResize) process.stdout.off("resize", onResize);
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
