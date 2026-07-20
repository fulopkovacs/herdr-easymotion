#!/usr/bin/env node
"use strict";

const { focusPane, paneGraphicsClearMany } = require("./herdr");

function parsePaneIds(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((paneId) => typeof paneId === "string" && paneId.length > 0) : [];
  } catch {
    return [];
  }
}

async function main() {
  const targetPaneId = process.argv[2] || "";
  const paneIds = parsePaneIds(process.argv[3] || "[]");

  await new Promise((resolve) => setTimeout(resolve, 50));

  if (targetPaneId) {
    await focusPane(targetPaneId, process.env);
  }

  if (paneIds.length > 0) {
    await paneGraphicsClearMany(paneIds, process.env).catch(() => {});
  }
}

main().catch(() => {
  process.exit(1);
});
