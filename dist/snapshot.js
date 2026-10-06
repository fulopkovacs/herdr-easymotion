"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureSnapshots = captureSnapshots;
exports.snapshotRows = snapshotRows;
exports.renderSnapshot = renderSnapshot;
/* eslint-disable no-control-regex -- Terminal snapshots require parsing and filtering escape sequences. */
const core_1 = require("./core");
const graphics_1 = require("./graphics");
const herdr_1 = require("./herdr");
const RESET = "\x1b[0m";
// Every code point in these ranges is a grapheme on its own (none extend, join,
// or prepend), so such text can skip Intl.Segmenter, whose ICU data costs ~10ms
// to load on startup.
const SIMPLE_TEXT = /^[\t\x20-\x7e\xa0-\u02ff\u2190-\u23ff\u2500-\u27bf\ue000-\uf8ff]*$/;
let segmenter;
const widthCache = new Map();
const styleCache = new Map();
function* segmentGraphemes(text) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment } of segmenter.segment(text))
        yield segment;
}
function graphemes(text) {
    return SIMPLE_TEXT.test(text) ? text : segmentGraphemes(text);
}
function emptySgr() {
    return {
        bold: false,
        dim: false,
        italic: false,
        underline: "",
        blink: "",
        inverse: false,
        hidden: false,
        strike: false,
        overline: false,
        fg: "",
        bg: "",
        underlineColor: "",
    };
}
// Apply one SGR parameter string the way a terminal would. Styles are kept as
// state rather than concatenated escapes, so long colorful lines cannot grow a
// cell's style (and the rendered output) without bound.
function applySgr(state, params) {
    const tokens = params.split(";");
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.includes(":")) {
            const [head, sub] = token.split(":");
            if (head === "38")
                state.fg = token;
            else if (head === "48")
                state.bg = token;
            else if (head === "58")
                state.underlineColor = token;
            else if (head === "4")
                state.underline = sub === "0" ? "" : token;
            continue;
        }
        const code = Number(token);
        if (code === 38 || code === 48 || code === 58) {
            const mode = Number(tokens[i + 1]);
            const count = mode === 5 ? 1 : mode === 2 ? 3 : -1;
            if (count === -1)
                return;
            // Like common terminals, missing color components default to 0.
            const components = Array.from({ length: count }, (_, k) => Number(tokens[i + 2 + k] ?? 0));
            const color = [code, mode, ...components].join(";");
            i += 1 + count;
            if (code === 38)
                state.fg = color;
            else if (code === 48)
                state.bg = color;
            else
                state.underlineColor = color;
            continue;
        }
        if (code === 0)
            Object.assign(state, emptySgr());
        else if (code === 1)
            state.bold = true;
        else if (code === 2)
            state.dim = true;
        else if (code === 3)
            state.italic = true;
        else if (code === 4 || code === 21)
            state.underline = String(code);
        else if (code === 5 || code === 6)
            state.blink = String(code);
        else if (code === 7)
            state.inverse = true;
        else if (code === 8)
            state.hidden = true;
        else if (code === 9)
            state.strike = true;
        else if (code === 22)
            state.bold = state.dim = false;
        else if (code === 23)
            state.italic = false;
        else if (code === 24)
            state.underline = "";
        else if (code === 25)
            state.blink = "";
        else if (code === 27)
            state.inverse = false;
        else if (code === 28)
            state.hidden = false;
        else if (code === 29)
            state.strike = false;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
            state.fg = token;
        else if (code === 39)
            state.fg = "";
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
            state.bg = token;
        else if (code === 49)
            state.bg = "";
        else if (code === 53)
            state.overline = true;
        else if (code === 55)
            state.overline = false;
        else if (code === 59)
            state.underlineColor = "";
    }
}
function sgrStyle(state) {
    const params = [
        state.bold && "1",
        state.dim && "2",
        state.italic && "3",
        state.underline,
        state.blink,
        state.inverse && "7",
        state.hidden && "8",
        state.strike && "9",
        state.overline && "53",
        state.fg,
        state.bg,
        state.underlineColor,
    ].filter(Boolean);
    return params.length ? `\x1b[${params.join(";")}m` : "";
}
function styleInfo(style) {
    let info = styleCache.get(style);
    if (!info) {
        const state = emptySgr();
        applySgr(state, style.slice(2, -1));
        const blankInvisible = !(state.underline ||
            state.inverse ||
            state.strike ||
            state.overline ||
            state.bg);
        state.dim = true;
        info = { dimmed: sgrStyle(state), blankInvisible };
        styleCache.set(style, info);
    }
    return info;
}
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
    // Latin text, borders, and FIGlet blocks are always one cell wide.
    const first = text.charCodeAt(0);
    if (text.length === 1 && (first < 0x300 || (first >= 0x2500 && first <= 0x259f)))
        return 1;
    let width = widthCache.get(text);
    if (width === undefined) {
        width = uncachedCellWidth(text);
        if (widthCache.size > 4096)
            widthCache.clear();
        widthCache.set(text, width);
    }
    return width;
}
function uncachedCellWidth(text) {
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
    const state = emptySgr();
    let style = "";
    const lines = safe.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === "")
        lines.pop();
    return lines.map((line) => {
        const cells = [];
        // SGR escapes survived sanitizing above; all other text is printable.
        const parts = line.split(/\x1b\[([\d;:]*)m/);
        for (let index = 0; index < parts.length; index++) {
            // Odd indexes are the captured SGR parameters between text parts.
            if (index % 2 === 1) {
                applySgr(state, parts[index]);
                style = sgrStyle(state);
                continue;
            }
            const part = parts[index].replace(/[\r\x1b]/g, "");
            if (!part)
                continue;
            let space;
            for (const segment of graphemes(part)) {
                if (segment === "\t") {
                    space ??= { text: " ", style, width: 1 };
                    const spaces = 8 - (cells.length % 8);
                    for (let i = 0; i < spaces; i++)
                        cells.push(space);
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
// Much faster than Array.from for the viewport-sized grids built per frame.
function filledArray(length, value) {
    const array = [];
    for (let i = 0; i < length; i++)
        array.push(value);
    return array;
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
    // Flat parallel arrays avoid allocating an object for every viewport cell.
    const texts = filledArray(width * height, " ");
    const styles = filledArray(width * height, "");
    const widths = new Uint8Array(width * height).fill(1);
    const area = layoutArea(layout, targets);
    // A 100% popup shares the tab's outer rectangle. Its content begins one
    // cell inside that rectangle; the right scrollbar gutter is simply cropped.
    const originX = area.x + 1;
    const originY = area.y + 1;
    const set = (index, text, style, cellWidth) => {
        texts[index] = text;
        styles[index] = style;
        widths[index] = cellWidth;
    };
    const put = (x, y, text, style, cellWidth) => {
        if (x < 0 || y < 0 || y >= height || x + cellWidth > width || cellWidth === 0)
            return;
        const index = y * width + x;
        if (widths[index] === 0 && x > 0)
            set(index - 1, " ", "", 1);
        if (widths[index] === 2 && x + 1 < width)
            set(index + 1, " ", "", 1);
        if (cellWidth === 2 && widths[index + 1] === 2 && x + 2 < width) {
            set(index + 2, " ", "", 1);
        }
        set(index, text, style, cellWidth);
        if (cellWidth === 2)
            set(index + 1, "", style, 0);
    };
    const writeText = (x, y, text, style) => {
        for (const segment of graphemes(text)) {
            const width = cellWidth(segment);
            put(x, y, segment, style, width);
            x += width;
        }
    };
    targets.forEach((target, index) => {
        const snapshot = snapshots.find((snapshot) => snapshot.paneId === target.paneId);
        const content = snapshotRows(snapshot?.text || "");
        const contentWidth = Math.max(0, ...content.map((line) => line.length));
        // Pane reads contain the content, not the surrounding pane border/gutter.
        const insetX = Math.min(1, Math.max(0, Math.floor((target.rect.width - contentWidth) / 2)));
        // A shared horizontal divider belongs to the pane below it. The upper
        // pane can therefore have a top border but no bottom border: a one-row
        // difference must inset the content by one, not round down to zero.
        const insetY = Math.min(1, Math.max(0, Math.ceil((target.rect.height - content.length) / 2)));
        const paneX = target.rect.x - originX;
        const paneY = target.rect.y - originY;
        for (let y = 0; y < Math.min(content.length, target.rect.height - insetY); y++) {
            for (let x = 0; x < Math.min(content[y].length, target.rect.width - insetX); x++) {
                const cell = content[y][x];
                if (x + cell.width > target.rect.width - insetX)
                    continue;
                const style = styleInfo(cell.style).dimmed;
                put(paneX + insetX + x, paneY + insetY + y, cell.text, style, cell.width);
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
    // The screen is cleared first, so cells that would look like cleared cells
    // are skipped with cursor jumps instead of being repainted.
    const output = ["\x1b[?7l", RESET, "\x1b[2J"];
    let current = "";
    for (let y = 0; y < height; y++) {
        let cursor = -1;
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const cellWidth = widths[index];
            const style = styles[index];
            if (cellWidth === 0 || (texts[index] === " " && styleInfo(style).blankInvisible))
                continue;
            if (cursor !== x) {
                // Short gaps are cheaper as spaces when the active style keeps them invisible.
                output.push(cursor !== -1 && x - cursor <= 8 && styleInfo(current).blankInvisible
                    ? " ".repeat(x - cursor)
                    : `\x1b[${y + 1};${x + 1}H`);
            }
            if (style !== current) {
                output.push(style ? `\x1b[0;${style.slice(2)}` : RESET);
                current = style;
            }
            output.push(texts[index]);
            cursor = x + cellWidth;
        }
    }
    output.push(RESET, "\x1b[?7h", "\x1b[H");
    return output.join("");
}
