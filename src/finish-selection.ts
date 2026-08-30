#!/usr/bin/env node

import { focusPane, paneGraphicsClearMany } from "./herdr";

function parsePaneIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((paneId): paneId is string => typeof paneId === "string" && paneId.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const targetPaneId = process.argv[2] || "";
  const paneIds = parsePaneIds(process.argv[3] || "[]");

  await new Promise<void>((resolve) => setTimeout(resolve, 50));

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
