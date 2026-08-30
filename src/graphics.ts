import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

type Color = readonly [red: number, green: number, blue: number, alpha: number];

interface FigletArt {
  lines: string[];
  width: number;
  height: number;
}

interface ResponsiveSize {
  width?: number;
  height?: number;
  bottomPadding?: number;
}

export interface CellSize {
  cell_width_px: number;
  cell_height_px: number;
}

interface OverlayTarget {
  shortcut: string;
  paneId: string;
  rect?: Partial<{
    width: number;
    height: number;
    x: number;
    y: number;
  }>;
}

interface OverlayOptions {
  env?: NodeJS.ProcessEnv;
}

export interface OverlayParams {
  pane_id: string;
  format: "png";
  image_width: number;
  image_height: number;
  data_base64: string;
  placement: {
    viewport_col: number;
    viewport_row: number;
    grid_cols: number;
    grid_rows: number;
  };
}

const TERMINUS_FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "terminus.flf");

export const HINT_COLORS: readonly Color[] = [
  [220, 88, 88, 245], // ANSI bright red
  [36, 114, 200, 245], // ANSI blue
  [210, 150, 45, 245], // ANSI amber
  [75, 185, 210, 245], // ANSI bright cyan
  [205, 49, 49, 245], // ANSI red
  [80, 150, 220, 245], // ANSI bright blue
  [229, 192, 64, 245], // ANSI yellow
  [17, 168, 205, 245], // ANSI cyan
  [205, 105, 205, 245], // ANSI bright magenta
  [13, 188, 121, 245], // ANSI green
  [188, 63, 188, 245], // ANSI magenta
  [55, 190, 120, 245], // ANSI bright green
];
const DARK_PANE_ID_BACKGROUND: Color = [0, 0, 0, 160];
const LIGHT_PANE_ID_BACKGROUND: Color = [255, 255, 255, 160];
const DARK_BACKGROUND: Color = [29, 32, 33, 255];
const LIGHT_BACKGROUND: Color = [251, 241, 199, 255];
const MIN_HINT_GRID_COLS = 13;
const MIN_HINT_GRID_ROWS = 12;

let crcTable: Uint32Array | null = null;
let systemBackground: Color | null = null;
const memoryCache = new Map<string, string>();
const figletCache = new Map<string, FigletArt>();

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function backgroundForEnv(env: NodeJS.ProcessEnv = process.env): Color {
  const appearance = env.HERDR_EASYMOTION_APPEARANCE?.toLowerCase();
  if (appearance === "light") {
    return LIGHT_BACKGROUND;
  }
  if (appearance === "dark") {
    return DARK_BACKGROUND;
  }
  if (systemBackground) {
    return systemBackground;
  }

  if (process.platform === "darwin") {
    const result = spawnSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    systemBackground =
      result.status === 0 && result.stdout.trim().toLowerCase() === "dark"
        ? DARK_BACKGROUND
        : LIGHT_BACKGROUND;
    return systemBackground;
  }

  systemBackground = DARK_BACKGROUND;
  return systemBackground;
}

export function paneIdBackgroundForEnv(env: NodeJS.ProcessEnv = process.env): Color {
  return backgroundForEnv(env) === LIGHT_BACKGROUND
    ? LIGHT_PANE_ID_BACKGROUND
    : DARK_PANE_ID_BACKGROUND;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  crcTable ||= makeCrcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const scanlines = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const scanlineOffset = row * (stride + 1);
    scanlines[scanlineOffset] = 0;
    rgba.copy(scanlines, scanlineOffset + 1, row * stride, row * stride + stride);
  }

  return Buffer.concat([
    header,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawRect(
  rgba: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Color,
): void {
  const [red, green, blue, alpha] = color;
  const startX = Math.max(0, x);
  const startY = Math.max(0, y);
  const endX = Math.min(width, x + rectWidth);
  const endY = Math.min(height, y + rectHeight);

  for (let row = startY; row < endY; row += 1) {
    for (let col = startX; col < endX; col += 1) {
      const offset = (row * width + col) * 4;
      rgba[offset] = red;
      rgba[offset + 1] = green;
      rgba[offset + 2] = blue;
      rgba[offset + 3] = alpha;
    }
  }
}

function renderFiglet(text: string, env: NodeJS.ProcessEnv = process.env): FigletArt {
  const figletBin = env.FIGLET_BIN || process.env.FIGLET_BIN || "figlet";
  const cacheKey = `${figletBin}:${text}`;
  const cached = figletCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = spawnSync(figletBin, ["-f", TERMINUS_FONT_PATH, "-w", "1000", String(text)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    throw new Error("figlet is required to render pane hints but was not found in PATH");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`figlet failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  let lines = result.stdout.replaceAll("\r", "").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const firstColumn = Math.min(
    ...lines.map((line) => line.search(/\S/)).filter((column) => column >= 0),
  );
  const lastColumn = Math.max(...lines.map((line) => line.search(/\s*$/)));
  lines = lines.map((line) => line.slice(firstColumn, lastColumn));

  const art = {
    lines,
    width: Math.max(...lines.map((line) => [...line].length)),
    height: lines.length * 2,
  };
  figletCache.set(cacheKey, art);
  return art;
}

function drawFiglet(
  rgba: Buffer,
  width: number,
  height: number,
  art: FigletArt,
  scale: number,
  originX: number,
  originY: number,
  color: Color,
): void {
  for (let row = 0; row < art.lines.length; row += 1) {
    for (const [col, character] of [...art.lines[row]].entries()) {
      if (character === "█" || character === "▀") {
        drawRect(
          rgba,
          width,
          height,
          originX + col * scale,
          originY + row * scale * 2,
          scale,
          scale,
          color,
        );
      }
      if (character === "█" || character === "▄") {
        drawRect(
          rgba,
          width,
          height,
          originX + col * scale,
          originY + (row * 2 + 1) * scale,
          scale,
          scale,
          color,
        );
      }
    }
  }
}

export function createHintPngBase64(
  shortcut: string,
  width: number,
  height: number,
  color: Color = HINT_COLORS[0],
  paneId = "",
  env: NodeJS.ProcessEnv = process.env,
  responsiveSize: ResponsiveSize | null = null,
): string {
  if (!positiveInteger(width) || !positiveInteger(height)) {
    throw new RangeError("Hint image dimensions must be positive safe integers");
  }

  const background = backgroundForEnv(env);
  const responsiveWidth = positiveInteger(responsiveSize?.width)
    ? Math.min(width, responsiveSize.width)
    : width;
  const responsiveHeight = positiveInteger(responsiveSize?.height)
    ? Math.min(height, responsiveSize.height)
    : height;
  const bottomPadding = positiveInteger(responsiveSize?.bottomPadding)
    ? Math.min(height - 1, responsiveSize.bottomPadding)
    : 0;
  const cacheKey = `v10:${shortcut}:${paneId}:${width}:${height}:${color.join(",")}:${background.join(",")}:${responsiveWidth}:${responsiveHeight}:${bottomPadding}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const shortcutArt = renderFiglet(shortcut, env);
  const label = String(paneId);
  const labelArt = label ? renderFiglet(label, env) : null;
  const labelScale = labelArt
    ? Math.max(1, Math.floor(Math.min(width / labelArt.width, height / 20)))
    : 0;
  const labelWidth = labelArt ? labelArt.width * labelScale : 0;
  const labelHeight = labelArt ? labelArt.height * labelScale : 0;
  const gap = label ? Math.max(2, Math.floor(height * 0.04)) : 0;
  const shortcutAreaHeight = height - labelHeight - gap - bottomPadding;
  const responsiveShortcutAreaHeight = responsiveHeight - labelHeight - gap - bottomPadding;
  const scale = Math.max(
    labelScale || 1,
    Math.floor(
      Math.min(
        width / shortcutArt.width,
        shortcutAreaHeight / shortcutArt.height,
        responsiveWidth / shortcutArt.width,
        responsiveShortcutAreaHeight / shortcutArt.height,
      ),
    ),
  );
  const shortcutWidth = shortcutArt.width * scale;
  const shortcutHeight = shortcutArt.height * scale;
  const originX = Math.floor((width - shortcutWidth) / 2);
  const originY = Math.floor((shortcutAreaHeight - shortcutHeight) / 2);
  const rgba = Buffer.alloc(width * height * 4);

  drawRect(rgba, width, height, 0, 0, width, height, background);
  drawFiglet(rgba, width, height, shortcutArt, scale, originX, originY, color);

  if (labelArt) {
    const labelX = Math.floor((width - labelWidth) / 2);
    const labelY = shortcutAreaHeight + gap;
    const padding = Math.max(1, labelScale);
    drawRect(
      rgba,
      width,
      height,
      labelX - padding,
      labelY - padding,
      labelWidth + padding * 2,
      labelHeight + padding * 2,
      paneIdBackgroundForEnv(env),
    );
    drawFiglet(rgba, width, height, labelArt, labelScale, labelX, labelY, color);
  }

  const base64 = encodePngRgba(width, height, rgba).toString("base64");
  memoryCache.set(cacheKey, base64);
  return base64;
}

export function colorForIndex(index: number): Color {
  return HINT_COLORS[index % HINT_COLORS.length];
}

function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HERDR_PLUGIN_CACHE_DIR ||
    env.HERDR_PLUGIN_STATE_DIR ||
    path.join(env.HOME || ".", ".cache", "herdr-easymotion")
  );
}

function diskCachePath(cacheKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), "graphics", `${Buffer.from(cacheKey).toString("hex")}.b64`);
}

function cellSizeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), "graphics", "cell-size.json");
}

export function getCachedHintBase64(
  cacheKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const base64 = readFileSync(diskCachePath(cacheKey, env), "utf8");
    memoryCache.set(cacheKey, base64);
    return base64;
  } catch {
    return null;
  }
}

function setCachedHintBase64(
  cacheKey: string,
  base64: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  memoryCache.set(cacheKey, base64);
  try {
    const filePath = diskCachePath(cacheKey, env);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, base64);
  } catch {
    // Cache failures should never block jumping.
  }
}

export function getCachedCellSize(env: NodeJS.ProcessEnv = process.env): CellSize | null {
  try {
    const value: unknown = JSON.parse(readFileSync(cellSizeCachePath(env), "utf8"));
    if (
      value !== null &&
      typeof value === "object" &&
      "cell_width_px" in value &&
      "cell_height_px" in value &&
      positiveInteger(value.cell_width_px) &&
      positiveInteger(value.cell_height_px)
    ) {
      return {
        cell_width_px: value.cell_width_px,
        cell_height_px: value.cell_height_px,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function setCachedCellSize(
  info: Partial<CellSize> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!positiveInteger(info?.cell_width_px) || !positiveInteger(info?.cell_height_px)) {
    return;
  }

  try {
    const filePath = cellSizeCachePath(env);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        cell_width_px: info.cell_width_px,
        cell_height_px: info.cell_height_px,
      }),
    );
  } catch {
    // Cache failures should never block jumping.
  }
}

export function createOverlayParams(
  target: OverlayTarget,
  graphicsInfo: Partial<CellSize> | null | undefined,
  index: number,
  options: OverlayOptions = {},
): OverlayParams {
  const env = options.env || process.env;
  const cellWidth = positiveInteger(graphicsInfo?.cell_width_px) ? graphicsInfo.cell_width_px : 1;
  const cellHeight = positiveInteger(graphicsInfo?.cell_height_px)
    ? graphicsInfo.cell_height_px
    : 1;
  const paneCols = positiveInteger(target?.rect?.width) ? target.rect.width : 1;
  const paneRows = positiveInteger(target?.rect?.height) ? target.rect.height : 1;
  const responsiveGridRows = Math.max(1, Math.min(28, Math.floor(paneRows * 0.68)));
  const responsiveGridCols = Math.max(1, Math.min(20, Math.ceil(responsiveGridRows * 0.72)));
  const gridRows = Math.max(MIN_HINT_GRID_ROWS, responsiveGridRows);
  const gridCols = Math.max(MIN_HINT_GRID_COLS, responsiveGridCols);
  const viewportCol = Math.max(0, Math.floor((paneCols - gridCols) / 2));
  const viewportRow = Math.max(0, Math.floor((paneRows - gridRows) / 2));
  const imageWidth = gridCols * cellWidth;
  const imageHeight = gridRows * cellHeight;
  const responsiveSize = {
    width: responsiveGridCols * cellWidth,
    height: responsiveGridRows * cellHeight,
    bottomPadding: cellHeight,
  };
  const color = colorForIndex(index);
  const background = backgroundForEnv(env);
  const cacheKey = `v10:${target.shortcut}:${target.paneId}:${imageWidth}:${imageHeight}:${color.join(",")}:${background.join(",")}:${responsiveSize.width}:${responsiveSize.height}:${responsiveSize.bottomPadding}`;
  let dataBase64 = getCachedHintBase64(cacheKey, env);
  if (!dataBase64) {
    dataBase64 = createHintPngBase64(
      target.shortcut,
      imageWidth,
      imageHeight,
      color,
      target.paneId,
      env,
      responsiveSize,
    );
    setCachedHintBase64(cacheKey, dataBase64, env);
  }

  return {
    pane_id: target.paneId,
    format: "png",
    image_width: imageWidth,
    image_height: imageHeight,
    data_base64: dataBase64,
    placement: {
      viewport_col: viewportCol,
      viewport_row: viewportRow,
      grid_cols: gridCols,
      grid_rows: gridRows,
    },
  };
}
