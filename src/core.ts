import path from "node:path";

export interface PaneRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface LayoutPane {
  pane_id?: string;
  focused?: boolean;
  rect?: PaneRect;
}

export interface PaneLayout {
  area?: PaneRect;
  focused_pane_id?: string;
  zoomed?: boolean;
  panes?: LayoutPane[];
}

export interface PaneInfo {
  pane_id?: string;
  label?: string;
  terminal_title_stripped?: string;
  terminal_title?: string;
  display_title?: string;
  agent?: string;
  agent_status?: string;
  foreground_cwd?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface PluginContext {
  focused_pane?: { pane_id?: string };
  focused_pane_id?: string;
  pane?: { pane_id?: string };
  pane_id?: string;
  target_pane_id?: string;
  message?: string;
  panes?: LayoutPane[];
  [key: string]: unknown;
}

export interface PaneTarget {
  shortcut: string;
  paneId: string;
  label: string;
  focused: boolean;
  rect: Required<PaneRect>;
}

export interface Status {
  title: string;
  message: string;
  detail: string;
}

export interface PaneListResponse {
  result?: { panes?: PaneInfo[] };
  panes?: PaneInfo[];
}

export const SHORTCUTS = "123456789abcdefghijklmnoprstuvwxyz".split("");

export function parsePluginContext(value: string | null | undefined): PluginContext {
  if (!value) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as PluginContext) : {};
  } catch {
    return {};
  }
}

export function resolvePaneIdFromContext(
  context: PluginContext | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = [
    env.HERDR_JUMP_SOURCE_PANE_ID,
    context?.focused_pane?.pane_id,
    context?.focused_pane_id,
    context?.pane?.pane_id,
    context?.pane_id,
    context?.target_pane_id,
    env.HERDR_PANE_ID,
  ];

  return (
    candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0) ?? null
  );
}

function paneSortKey(pane: LayoutPane): { y: number; x: number; paneId: string } {
  const rect = pane.rect ?? {};
  return {
    y: Number.isFinite(rect.y) ? (rect.y as number) : 0,
    x: Number.isFinite(rect.x) ? (rect.x as number) : 0,
    paneId: pane.pane_id ?? "",
  };
}

export function sortLayoutPanes(panes: readonly LayoutPane[]): LayoutPane[] {
  return [...panes].sort((left, right) => {
    const a = paneSortKey(left);
    const b = paneSortKey(right);

    return a.y - b.y || a.x - b.x || a.paneId.localeCompare(b.paneId);
  });
}

function basename(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  return path.basename(value) || value;
}

export function formatPaneLabel(
  layoutPane?: LayoutPane | null,
  paneInfo?: PaneInfo | null,
): string {
  const title =
    paneInfo?.label ||
    paneInfo?.terminal_title_stripped ||
    paneInfo?.terminal_title ||
    paneInfo?.display_title ||
    null;

  if (title) {
    return String(title);
  }

  if (paneInfo?.agent) {
    const status =
      paneInfo.agent_status && paneInfo.agent_status !== "unknown"
        ? ` ${paneInfo.agent_status}`
        : "";
    return `${paneInfo.agent}${status}`;
  }

  const cwdName = basename(paneInfo?.foreground_cwd) || basename(paneInfo?.cwd);
  if (cwdName) {
    return cwdName;
  }

  return layoutPane?.pane_id ?? "pane";
}

export function truncateMiddle(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }

  const keep = maxLength - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}.${text.slice(text.length - right)}`;
}

export function buildTargets(
  layout: PaneLayout | null | undefined,
  paneInfoById: ReadonlyMap<string, PaneInfo> = new Map(),
  sourcePaneId: string | null = null,
  options: { includeCurrent?: boolean } = {},
): PaneTarget[] {
  const currentPaneId = sourcePaneId || layout?.focused_pane_id || null;
  const includeCurrent = Boolean(options.includeCurrent);
  const visiblePanes = Array.isArray(layout?.panes) ? sortLayoutPanes(layout.panes) : [];

  return visiblePanes
    .filter((pane): pane is LayoutPane & { pane_id: string } =>
      Boolean(pane.pane_id && (includeCurrent || pane.pane_id !== currentPaneId)),
    )
    .slice(0, SHORTCUTS.length)
    .map((pane, index) => {
      const rect = pane.rect ?? {};
      const info = paneInfoById.get(pane.pane_id);

      return {
        shortcut: SHORTCUTS[index],
        paneId: pane.pane_id,
        label: formatPaneLabel(pane, info),
        focused: Boolean(pane.focused),
        rect: {
          x: Number.isFinite(rect.x) ? (rect.x as number) : 0,
          y: Number.isFinite(rect.y) ? (rect.y as number) : 0,
          width: Number.isFinite(rect.width) ? (rect.width as number) : 0,
          height: Number.isFinite(rect.height) ? (rect.height as number) : 0,
        },
      };
    });
}

export function indexPaneInfo(
  paneListResponse: PaneListResponse | null | undefined,
): Map<string, PaneInfo> {
  const panes = paneListResponse?.result?.panes ?? paneListResponse?.panes ?? [];
  return new Map(
    panes
      .filter(
        (pane): pane is PaneInfo & { pane_id: string } => pane && typeof pane.pane_id === "string",
      )
      .map((pane) => [pane.pane_id, pane]),
  );
}

export function createStatus(
  layout: PaneLayout | null | undefined,
  targets: readonly Pick<PaneTarget, "paneId">[],
  sourcePaneId: string | null | undefined,
): Status | null {
  if (layout?.zoomed) {
    return {
      title: "Jump",
      message: "Only the zoomed pane is visible.",
      detail: "Unzoom the tab to jump to hidden panes.",
    };
  }

  if (!sourcePaneId && !layout?.focused_pane_id) {
    return {
      title: "Jump",
      message: "No source pane was available.",
      detail: "Invoke the action from a tiled pane.",
    };
  }

  if (targets.length === 0) {
    return {
      title: "Jump",
      message: "No other visible panes.",
      detail: "Split this tab to create another jump target.",
    };
  }

  return null;
}
