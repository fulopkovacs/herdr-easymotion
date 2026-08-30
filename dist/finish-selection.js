#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const herdr_1 = require("./herdr");
function parsePaneIds(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((paneId) => typeof paneId === "string" && paneId.length > 0)
            : [];
    }
    catch {
        return [];
    }
}
async function main() {
    const targetPaneId = process.argv[2] || "";
    const paneIds = parsePaneIds(process.argv[3] || "[]");
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (targetPaneId) {
        await (0, herdr_1.focusPane)(targetPaneId, process.env);
    }
    if (paneIds.length > 0) {
        await (0, herdr_1.paneGraphicsClearMany)(paneIds, process.env).catch(() => { });
    }
}
main().catch(() => {
    process.exit(1);
});
