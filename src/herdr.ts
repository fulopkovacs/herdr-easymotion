import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

import type { PaneInfo, PaneLayout, PaneListResponse } from "./core";

export interface HerdrRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HerdrRequestOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  id?: string;
  timeoutMs?: number | string;
}

export interface HerdrResponse<TResult = unknown> {
  id?: string;
  result?: TResult;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

export interface PaneGraphicsInfo {
  cell_width_px?: number;
  cell_height_px?: number;
  [key: string]: unknown;
}

export interface PaneGraphicsSetParams {
  pane_id: string;
  [key: string]: unknown;
}

export interface PluginPaneOpenParams extends Record<string, unknown> {
  plugin_id: string;
  entrypoint: string;
  placement?: "overlay" | "popup" | "split" | "tab" | "zoomed";
  env?: Record<string, string>;
  focus?: boolean;
}

export const MAX_TIMEOUT_MS = 2_147_483_647;

export class HerdrRequestError extends Error {
  readonly code: string | null;

  constructor(code?: string | null, message?: string | null) {
    super(
      code ? `${code}: ${message || "Herdr request failed"}` : message || "Herdr request failed",
    );
    this.name = "HerdrRequestError";
    this.code = code || null;
  }
}

export function herdrBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_BIN_PATH || "herdr";
}

function herdrExitError(args: readonly string[], status: number | null, stderr: string): Error {
  const detail = stderr ? `: ${stderr.trim()}` : "";
  return new Error(`herdr ${args.join(" ")} failed with exit ${status}${detail}`);
}

function herdrInvalidJsonError(args: readonly string[], error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`herdr ${args.join(" ")} returned invalid JSON: ${message}`);
}

function parseHerdrJson<T>(args: readonly string[], stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw herdrInvalidJsonError(args, error);
  }
}

export function requestTimeoutMs(
  options: Pick<HerdrRequestOptions, "timeoutMs"> = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = options.timeoutMs ?? env.HERDR_REQUEST_TIMEOUT_MS ?? 5000;
  const timeoutMs = Number(value);
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
    : 5000;
}

export function runHerdrJson<T = unknown>(
  args: readonly string[],
  options: HerdrRunOptions = {},
): T {
  const env = options.env || process.env;
  const result = spawnSync(herdrBin(env), args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw herdrExitError(args, result.status, result.stderr);
  }

  return parseHerdrJson<T>(args, result.stdout);
}

export function runHerdrJsonAsync<T = unknown>(
  args: readonly string[],
  options: HerdrRunOptions = {},
): Promise<T> {
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(herdrBin(env), args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(herdrExitError(args, status, stderr));
        return;
      }

      try {
        resolve(parseHerdrJson<T>(args, stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function runHerdr(args: readonly string[], options: HerdrRunOptions = {}): string {
  const env = options.env || process.env;
  const result = spawnSync(herdrBin(env), args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw herdrExitError(args, result.status, result.stderr);
  }

  return result.stdout;
}

export function request<TResult = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options: HerdrRequestOptions = {},
): Promise<HerdrResponse<TResult>> {
  const env = options.env || process.env;
  const socketPath = options.socketPath || env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    return Promise.reject(new Error("HERDR_SOCKET_PATH is not set"));
  }

  const id = options.id || `herdr-easymotion:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ id, method, params }) + "\n";
  const timeoutMs = requestTimeoutMs(options, env);

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const socket = net.createConnection(socketPath);

    function finish(error: Error | null, value?: HerdrResponse<TResult>): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value as HerdrResponse<TResult>);
      }
    }

    function handleLine(line: string): void {
      if (!line.trim()) {
        return;
      }

      let response: HerdrResponse<TResult>;
      try {
        response = JSON.parse(line) as HerdrResponse<TResult>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error(`Herdr returned invalid JSON: ${message}`));
        return;
      }

      if (response.id !== id) {
        finish(new Error(`Herdr returned response for unexpected id ${response.id}`));
        return;
      }

      if (response.error) {
        finish(new HerdrRequestError(response.error.code, response.error.message));
        return;
      }

      finish(null, response);
    }

    socket.setEncoding("utf8");
    timeout = setTimeout(
      () => finish(new Error(`Herdr request ${method} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (!settled) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          break;
        }

        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        handleLine(line);
      }
    });

    socket.on("error", finish);
    socket.on("end", () => {
      if (!settled) {
        finish(new Error("Herdr socket closed before a response was received"));
      }
    });
    socket.on("close", () => {
      if (!settled) {
        finish(new Error("Herdr socket closed before a response was received"));
      }
    });
  });
}

interface PaneLayoutResponse {
  result?: { layout?: PaneLayout } | PaneLayout;
  layout?: PaneLayout;
}

function paneLayoutFromResponse(response: PaneLayoutResponse): PaneLayout | undefined {
  const result = response.result;
  return (
    (result && "layout" in result ? result.layout : undefined) ??
    response.layout ??
    (result as PaneLayout | undefined)
  );
}

function paneLayoutArgs(paneId?: string | null): string[] {
  return paneId ? ["pane", "layout", "--pane", paneId] : ["pane", "layout", "--current"];
}

export function paneLayout(
  paneId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): PaneLayout | undefined {
  return paneLayoutFromResponse(runHerdrJson<PaneLayoutResponse>(paneLayoutArgs(paneId), { env }));
}

export async function paneLayoutAsync(
  paneId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneLayout | undefined> {
  // The socket API avoids spawning the herdr CLI (~20ms) on the picker's critical path.
  if (paneId && env.HERDR_SOCKET_PATH) {
    try {
      const response = await request<{ layout?: PaneLayout }>(
        "pane.layout",
        { pane_id: paneId },
        { env },
      );
      const layout = response.result?.layout;
      if (layout && typeof layout === "object" && Array.isArray(layout.panes)) {
        return layout;
      }
    } catch {
      // Fall back to the CLI, which also works where the socket method is unavailable.
    }
  }

  return paneLayoutFromResponse(
    await runHerdrJsonAsync<PaneLayoutResponse>(paneLayoutArgs(paneId), { env }),
  );
}

export function paneList(env: NodeJS.ProcessEnv = process.env): PaneListResponse {
  return runHerdrJson<PaneListResponse>(["pane", "list"], { env });
}

export function focusPane(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse> {
  return request("pane.focus", { pane_id: paneId }, { env });
}

export function openPluginPane(
  params: PluginPaneOpenParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse> {
  return request("plugin.pane.open", params, { env });
}

export async function paneGraphicsInfo(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneGraphicsInfo> {
  const response = await request<PaneGraphicsInfo & { info?: PaneGraphicsInfo }>(
    "pane.graphics.info",
    { pane_id: paneId },
    { env },
  );
  return (response.result?.info ?? response.result ?? response) as PaneGraphicsInfo;
}

export function paneGraphicsSet(
  params: PaneGraphicsSetParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse> {
  return request("pane.graphics.set", params, { env });
}

export function paneGraphicsClear(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse> {
  return request("pane.graphics.clear", { pane_id: paneId }, { env });
}

export async function settleRequests<T>(requests: Iterable<PromiseLike<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(requests);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export function paneGraphicsSetMany(
  paramsList: readonly PaneGraphicsSetParams[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse[]> {
  return settleRequests(paramsList.map((params) => paneGraphicsSet(params, env)));
}

export function paneGraphicsClearMany(
  paneIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrResponse[]> {
  return settleRequests([...new Set(paneIds)].map((paneId) => paneGraphicsClear(paneId, env)));
}

export type { PaneInfo, PaneLayout, PaneListResponse };
