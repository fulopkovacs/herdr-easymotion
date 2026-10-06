"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HerdrRequestError = exports.MAX_TIMEOUT_MS = void 0;
exports.herdrBin = herdrBin;
exports.requestTimeoutMs = requestTimeoutMs;
exports.runHerdrJson = runHerdrJson;
exports.runHerdrJsonAsync = runHerdrJsonAsync;
exports.runHerdr = runHerdr;
exports.request = request;
exports.paneLayout = paneLayout;
exports.paneLayoutAsync = paneLayoutAsync;
exports.paneList = paneList;
exports.focusPane = focusPane;
exports.openPluginPane = openPluginPane;
exports.paneGraphicsInfo = paneGraphicsInfo;
exports.paneGraphicsSet = paneGraphicsSet;
exports.paneGraphicsClear = paneGraphicsClear;
exports.settleRequests = settleRequests;
exports.paneGraphicsSetMany = paneGraphicsSetMany;
exports.paneGraphicsClearMany = paneGraphicsClearMany;
const node_child_process_1 = require("node:child_process");
const node_net_1 = __importDefault(require("node:net"));
exports.MAX_TIMEOUT_MS = 2_147_483_647;
class HerdrRequestError extends Error {
    code;
    constructor(code, message) {
        super(code ? `${code}: ${message || "Herdr request failed"}` : message || "Herdr request failed");
        this.name = "HerdrRequestError";
        this.code = code || null;
    }
}
exports.HerdrRequestError = HerdrRequestError;
function herdrBin(env = process.env) {
    return env.HERDR_BIN_PATH || "herdr";
}
function herdrExitError(args, status, stderr) {
    const detail = stderr ? `: ${stderr.trim()}` : "";
    return new Error(`herdr ${args.join(" ")} failed with exit ${status}${detail}`);
}
function herdrInvalidJsonError(args, error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`herdr ${args.join(" ")} returned invalid JSON: ${message}`);
}
function parseHerdrJson(args, stdout) {
    try {
        return JSON.parse(stdout);
    }
    catch (error) {
        throw herdrInvalidJsonError(args, error);
    }
}
function requestTimeoutMs(options = {}, env = process.env) {
    const value = options.timeoutMs ?? env.HERDR_REQUEST_TIMEOUT_MS ?? 5000;
    const timeoutMs = Number(value);
    return Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, exports.MAX_TIMEOUT_MS)
        : 5000;
}
function runHerdrJson(args, options = {}) {
    const env = options.env || process.env;
    const result = (0, node_child_process_1.spawnSync)(herdrBin(env), args, {
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
    return parseHerdrJson(args, result.stdout);
}
function runHerdrJsonAsync(args, options = {}) {
    const env = options.env || process.env;
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(herdrBin(env), args, {
            cwd: options.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => {
            if (status !== 0) {
                reject(herdrExitError(args, status, stderr));
                return;
            }
            try {
                resolve(parseHerdrJson(args, stdout));
            }
            catch (error) {
                reject(error);
            }
        });
    });
}
function runHerdr(args, options = {}) {
    const env = options.env || process.env;
    const result = (0, node_child_process_1.spawnSync)(herdrBin(env), args, {
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
function request(method, params = {}, options = {}) {
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
        let timeout;
        const socket = node_net_1.default.createConnection(socketPath);
        function finish(error, value) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            if (error) {
                reject(error);
            }
            else {
                resolve(value);
            }
        }
        function handleLine(line) {
            if (!line.trim()) {
                return;
            }
            let response;
            try {
                response = JSON.parse(line);
            }
            catch (error) {
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
        timeout = setTimeout(() => finish(new Error(`Herdr request ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
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
function paneLayoutFromResponse(response) {
    const result = response.result;
    return ((result && "layout" in result ? result.layout : undefined) ??
        response.layout ??
        result);
}
function paneLayoutArgs(paneId) {
    return paneId ? ["pane", "layout", "--pane", paneId] : ["pane", "layout", "--current"];
}
function paneLayout(paneId, env = process.env) {
    return paneLayoutFromResponse(runHerdrJson(paneLayoutArgs(paneId), { env }));
}
async function paneLayoutAsync(paneId, env = process.env) {
    // The socket API avoids spawning the herdr CLI (~20ms) on the picker's critical path.
    if (paneId && env.HERDR_SOCKET_PATH) {
        try {
            const response = await request("pane.layout", { pane_id: paneId }, { env });
            const layout = response.result?.layout;
            if (layout && typeof layout === "object" && Array.isArray(layout.panes)) {
                return layout;
            }
        }
        catch {
            // Fall back to the CLI, which also works where the socket method is unavailable.
        }
    }
    return paneLayoutFromResponse(await runHerdrJsonAsync(paneLayoutArgs(paneId), { env }));
}
function paneList(env = process.env) {
    return runHerdrJson(["pane", "list"], { env });
}
function focusPane(paneId, env = process.env) {
    return request("pane.focus", { pane_id: paneId }, { env });
}
function openPluginPane(params, env = process.env) {
    return request("plugin.pane.open", params, { env });
}
async function paneGraphicsInfo(paneId, env = process.env) {
    const response = await request("pane.graphics.info", { pane_id: paneId }, { env });
    return (response.result?.info ?? response.result ?? response);
}
function paneGraphicsSet(params, env = process.env) {
    return request("pane.graphics.set", params, { env });
}
function paneGraphicsClear(paneId, env = process.env) {
    return request("pane.graphics.clear", { pane_id: paneId }, { env });
}
async function settleRequests(requests) {
    const settled = await Promise.allSettled(requests);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) {
        throw failure.reason;
    }
    return settled.map((result) => result.value);
}
function paneGraphicsSetMany(paramsList, env = process.env) {
    return settleRequests(paramsList.map((params) => paneGraphicsSet(params, env)));
}
function paneGraphicsClearMany(paneIds, env = process.env) {
    return settleRequests([...new Set(paneIds)].map((paneId) => paneGraphicsClear(paneId, env)));
}
