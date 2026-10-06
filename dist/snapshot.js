"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureSnapshots = captureSnapshots;
exports.snapshotRows = snapshotRows;
exports.renderSnapshot = renderSnapshot;
/* eslint-disable no-control-regex -- Terminal snapshots require parsing and filtering escape sequences. */
const core_1 = require("./core");
const graphics_1 = require("./graphics");
const herdr_1 = require("./herdr");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const RESET = "\x1b[0m";
function scaleHint(lines, scale) {
    if (scale === 1)
        return [...lines];
    const width = Math.max(...lines.map((line) => [...line].length));
    const glyph = lines.map((line) => [...line]);
    const pixel = (x, y) => {
        const char = glyph[Math.floor(y / 2)]?.[x];
        return char === "█" || char === (y % 2 === 0 ? "▀" : "▄");
    };
    return Array.from({ length: lines.length * scale }, (_, row) => Array.from({ length: width * scale }, (_, col) => {
        const x = Math.floor(col / scale);
        const top = pixel(x, Math.floor((row * 2) / scale));
        const bottom = pixel(x, Math.floor((row * 2 + 1) / scale));
        return top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }).join(""));
}
async function captureSnapshots(targets, env = process.env) {
    return Promise.all(targets.map(async (target) => {
        try {
            const response = await (0, herdr_1.request)("pane.read", {
                pane_id: target.paneId,
                source: "visible",
                format: "ansi",
                strip_ansi: false,
                lines: Math.max(1, Math.min(65535, target.rect.height)),
            }, { env });
            const text = response.result?.read?.text;
            if (typeof text !== "string") {
                throw new Error("Herdr returned no visible pane text");
            }
            return { paneId: target.paneId, text };
        }
        catch (error) {
            // A closing/unreadable pane must not hide hints for the other panes.
            return {
                paneId: target.paneId,
                text: "",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
}
function cellWidth(text) {
    const code = text.codePointAt(0) || 0;
    if (/^(?:\p{Mark}|\u200d|\ufe0f)+$/u.test(text))
        return 0;
    if (/\p{Emoji_Presentation}|\ufe0f/u.test(text))
        return 2;
    return code >= 0x1100 &&
        (code <= 0x115f ||
            code === 0x2329 ||
            code === 0x232a ||
            (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe10 && code <= 0xfe19) ||
            (code >= 0xfe30 && code <= 0xfe6f) ||
            (code >= 0xff00 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6) ||
            (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1;
}
// Replaying a snapshot must never execute cursor movement, clipboard writes,
// hyperlinks, graphics commands, or other application terminal controls.
function snapshotRows(text) {
    const safe = text
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[PX\]^_][\s\S]*?(?:\x07|\x1b\\)|[ -/]*[@-~])/g, (sequence) => (/^\x1b\[[\d;:]*m$/.test(sequence) ? sequence : ""))
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
    let style = "";
    const lines = safe.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === "")
        lines.pop();
    return lines.map((line) => {
        const cells = [];
        // SGR escapes survived sanitizing above; all other text is printable.
        for (const part of line.split(/(\x1b\[[\d;:]*m)/)) {
            if (/^\x1b\[[\d;:]*m$/.test(part)) {
                style = /^\x1b\[(?:0(?:;|m)|m)/.test(part) ? part : style + part;
                continue;
            }
            for (const { segment } of segmenter.segment(part.replace(/[\r\x1b]/g, ""))) {
                if (segment === "\t") {
                    const spaces = 8 - (cells.length % 8);
                    for (let i = 0; i < spaces; i++)
                        cells.push({ text: " ", style, width: 1 });
                    continue;
                }
                const width = cellWidth(segment);
                if (width === 0)
                    continue;
                cells.push({ text: segment, style, width });
                if (width === 2)
                    cells.push({ text: "", style, width: 0 });
            }
        }
        return cells;
    });
}
function layoutArea(layout, targets) {
    const x = layout.area?.x ?? (targets.length ? Math.min(...targets.map((target) => target.rect.x)) : 0);
    const y = layout.area?.y ?? (targets.length ? Math.min(...targets.map((target) => target.rect.y)) : 0);
    return {
        x,
        y,
        width: layout.area?.width ??
            Math.max(1, ...targets.map((target) => target.rect.x + target.rect.width - x)),
        height: layout.area?.height ??
            Math.max(1, ...targets.map((target) => target.rect.y + target.rect.height - y)),
    };
}
function renderSnapshot(layout, targets, snapshots, columns, rows, env = process.env) {
    const width = Math.max(1, Math.min(4096, Math.floor(columns) || 1));
    const height = Math.max(1, Math.min(4096, Math.floor(rows) || 1));
    if (width * height > 1_000_000)
        throw new Error("Snapshot viewport is too large");
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " ", style: "", width: 1 })));
    const area = layoutArea(layout, targets);
    // A 100% popup shares the tab's outer rectangle. Its content begins one
    // cell inside that rectangle; the right scrollbar gutter is simply cropped.
    const originX = area.x + 1;
    const originY = area.y + 1;
    const put = (x, y, cell) => {
        if (x < 0 || y < 0 || y >= height || x + cell.width > width || cell.width === 0)
            return;
        const row = grid[y];
        if (row[x].width === 0 && x > 0)
            row[x - 1] = { text: " ", style: "", width: 1 };
        if (row[x].width === 2 && x + 1 < width)
            row[x + 1] = { text: " ", style: "", width: 1 };
        if (cell.width === 2 && row[x + 1].width === 2 && x + 2 < width) {
            row[x + 2] = { text: " ", style: "", width: 1 };
        }
        row[x] = cell;
        if (cell.width === 2)
            row[x + 1] = { text: "", style: cell.style, width: 0 };
    };
    const writeText = (x, y, text, style) => {
        for (const { segment } of segmenter.segment(text)) {
            const width = cellWidth(segment);
            put(x, y, { text: segment, style, width });
            x += width;
        }
    };
    targets.forEach((target, index) => {
        const snapshot = snapshots.find((snapshot) => snapshot.paneId === target.paneId);
        const content = snapshotRows(snapshot?.text || "");
        const contentWidth = Math.max(0, ...content.map((line) => line.length));
        // Pane reads contain the content, not the surrounding pane border/gutter.
        const insetX = Math.min(1, Math.max(0, Math.floor((target.rect.width - contentWidth) / 2)));
        const insetY = Math.min(1, Math.max(0, Math.floor((target.rect.height - content.length) / 2)));
        const paneX = target.rect.x - originX;
        const paneY = target.rect.y - originY;
        for (let y = 0; y < Math.min(content.length, target.rect.height - insetY); y++) {
            for (let x = 0; x < Math.min(content[y].length, target.rect.width - insetX); x++) {
                const cell = content[y][x];
                if (x + cell.width > target.rect.width - insetX)
                    continue;
                put(paneX + insetX + x, paneY + insetY + y, { ...cell, style: cell.style + "\x1b[2m" });
            }
        }
        const rect = {
            x: Math.max(0, paneX),
            y: Math.max(0, paneY),
            width: Math.min(width, paneX + target.rect.width) - Math.max(0, paneX),
            height: Math.min(height, paneY + target.rect.height) - Math.max(0, paneY),
        };
        if (rect.width <= 0 || rect.height <= 0)
            return;
        const borderStyle = "\x1b[38;2;100;100;100m";
        if (paneX > 0)
            for (let y = rect.y; y < rect.y + rect.height; y++)
                writeText(paneX, y, "│", borderStyle);
        if (paneY > 0)
            for (let x = rect.x; x < rect.x + rect.width; x++)
                writeText(x, paneY, "─", borderStyle);
        let art = (0, graphics_1.hintTextLines)(target.shortcut);
        let artWidth = Math.max(...art.map((line) => [...line].length));
        const scale = Math.max(1, Math.min(3, Math.floor((rect.width - 2) / artWidth), Math.floor((rect.height * 0.55 - 3) / art.length)));
        art = scaleHint(art, scale);
        artWidth *= scale;
        if (artWidth + 2 > rect.width || art.length + 3 > rect.height) {
            art = [target.shortcut];
            artWidth = 1;
        }
        const label = (0, core_1.truncateMiddle)(target.paneId, Math.max(1, rect.width - 2));
        const badgeWidth = Math.min(rect.width, Math.max(artWidth, label.length) + 2);
        const badgeHeight = Math.min(rect.height, art.length + 3);
        const badgeX = rect.x + Math.floor((rect.width - badgeWidth) / 2);
        const badgeY = rect.y + Math.floor((rect.height - badgeHeight) / 2);
        const [red, green, blue] = (0, graphics_1.colorForIndex)(index);
        const [bgRed, bgGreen, bgBlue] = (0, graphics_1.backgroundForEnv)(env);
        const style = `\x1b[1;38;2;${red};${green};${blue};48;2;${bgRed};${bgGreen};${bgBlue}m`;
        for (let y = badgeY; y < badgeY + badgeHeight; y++)
            writeText(badgeX, y, " ".repeat(badgeWidth), style);
        const artY = badgeY + (badgeHeight >= art.length + 2 ? 1 : 0);
        art.forEach((line, row) => {
            if (artY + row < badgeY + badgeHeight - 1) {
                writeText(badgeX + Math.floor((badgeWidth - artWidth) / 2), artY + row, line, style);
            }
        });
        // Even tiny panes show both the shortcut and ID when two rows fit.
        if (badgeHeight >= 2) {
            writeText(badgeX + Math.floor((badgeWidth - label.length) / 2), badgeY + badgeHeight - 1, label, style);
        }
        else {
            writeText(badgeX, badgeY, target.shortcut, style);
        }
        if (snapshot?.error && rect.height > badgeHeight + 2) {
            writeText(rect.x, rect.y, "Snapshot unavailable".slice(0, rect.width), borderStyle);
        }
    });
    const output = ["\x1b[?7l", RESET, "\x1b[2J\x1b[H"];
    for (let y = 0; y < height; y++) {
        output.push(`\x1b[${y + 1};1H`, RESET);
        let previousStyle = "";
        for (const cell of grid[y]) {
            if (cell.width === 0)
                continue;
            if (cell.style !== previousStyle) {
                output.push(RESET, cell.style);
                previousStyle = cell.style;
            }
            output.push(cell.text);
        }
    }
    output.push(RESET, "\x1b[?7h", "\x1b[H");
    return output.join("");
}
