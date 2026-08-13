"use strict";

const zlib = require("node:zlib");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const GLYPHS = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  a: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  b: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  c: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  d: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  e: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  f: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  g: ["01111", "10000", "10000", "10011", "10001", "10001", "01110"],
  h: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  i: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  j: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  k: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  l: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  m: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  n: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  o: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  p: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  r: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  s: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  t: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  u: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  v: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  w: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  x: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00100", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};

const HINT_COLORS = [
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

let crcTable = null;
const memoryCache = new Map();

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function makeCrcTable() {
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

function crc32(buffer) {
  crcTable ||= makeCrcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePngRgba(width, height, rgba) {
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
    chunk("IDAT", zlib.deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawRect(rgba, width, height, x, y, rectWidth, rectHeight, color) {
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

function drawText(rgba, width, height, text, scale, originX, originY, color) {
  let textX = originX;

  for (const character of text) {
    const glyph = GLYPHS[character.toLowerCase()] || GLYPHS["?"];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          drawRect(rgba, width, height, textX + col * scale, originY + row * scale, scale, scale, color);
        }
      }
    }
    textX += 6 * scale;
  }
}

function createHintPngBase64(shortcut, width, height, color = HINT_COLORS[0], paneId = "") {
  if (!positiveInteger(width) || !positiveInteger(height)) {
    throw new RangeError("Hint image dimensions must be positive safe integers");
  }

  const cacheKey = `v3:${shortcut}:${paneId}:${width}:${height}:${color.join(",")}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const glyph = GLYPHS[shortcut] || GLYPHS["1"];
  const glyphRows = glyph.length;
  const glyphCols = glyph[0].length;
  const label = String(paneId);
  const labelUnits = Math.max(1, label.length * 6 - 1);
  const labelScale = label ? Math.max(1, Math.floor(Math.min(width / labelUnits, height / 35))) : 0;
  const labelHeight = glyphRows * labelScale;
  const gap = label ? Math.max(2, Math.floor(height * 0.04)) : 0;
  const shortcutAreaHeight = height - labelHeight - gap;
  const scale = Math.max(2, Math.floor(Math.min(width / glyphCols, shortcutAreaHeight / glyphRows)));
  const glyphWidth = glyphCols * scale;
  const glyphHeight = glyphRows * scale;
  const originX = Math.floor((width - glyphWidth) / 2);
  const originY = Math.floor((shortcutAreaHeight - glyphHeight) / 2);
  const rgba = Buffer.alloc(width * height * 4);

  drawText(rgba, width, height, shortcut, scale, originX, originY, color);

  if (label) {
    const labelWidth = labelUnits * labelScale;
    const labelX = Math.floor((width - labelWidth) / 2);
    const labelY = shortcutAreaHeight + gap;
    drawText(rgba, width, height, label, labelScale, labelX, labelY, color);
  }

  const base64 = encodePngRgba(width, height, rgba).toString("base64");
  memoryCache.set(cacheKey, base64);
  return base64;
}

function colorForIndex(index) {
  return HINT_COLORS[index % HINT_COLORS.length];
}

function cacheDir(env = process.env) {
  return env.HERDR_PLUGIN_CACHE_DIR || env.HERDR_PLUGIN_STATE_DIR || path.join(env.HOME || ".", ".cache", "herdr-easymotion");
}

function diskCachePath(cacheKey, env = process.env) {
  return path.join(cacheDir(env), "graphics", `${Buffer.from(cacheKey).toString("hex")}.b64`);
}

function cellSizeCachePath(env = process.env) {
  return path.join(cacheDir(env), "graphics", "cell-size.json");
}

function getCachedHintBase64(cacheKey, env = process.env) {
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

function setCachedHintBase64(cacheKey, base64, env = process.env) {
  memoryCache.set(cacheKey, base64);
  try {
    const filePath = diskCachePath(cacheKey, env);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, base64);
  } catch {
    // Cache failures should never block jumping.
  }
}

function getCachedCellSize(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(cellSizeCachePath(env), "utf8"));
    if (positiveInteger(value.cell_width_px) && positiveInteger(value.cell_height_px)) {
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

function setCachedCellSize(info, env = process.env) {
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

function createOverlayParams(target, graphicsInfo, index, options = {}) {
  const env = options.env || process.env;
  const cellWidth = positiveInteger(graphicsInfo?.cell_width_px) ? graphicsInfo.cell_width_px : 1;
  const cellHeight = positiveInteger(graphicsInfo?.cell_height_px) ? graphicsInfo.cell_height_px : 1;
  const paneCols = positiveInteger(target?.rect?.width) ? target.rect.width : 1;
  const paneRows = positiveInteger(target?.rect?.height) ? target.rect.height : 1;
  const gridRows = Math.max(7, Math.min(28, Math.floor(paneRows * 0.68)));
  const gridCols = Math.max(5, Math.min(20, Math.ceil(gridRows * 0.72)));
  const viewportCol = Math.max(0, Math.floor((paneCols - gridCols) / 2));
  const viewportRow = Math.max(0, Math.floor((paneRows - gridRows) / 2));
  const imageWidth = gridCols * cellWidth;
  const imageHeight = gridRows * cellHeight;
  const color = colorForIndex(index);
  const cacheKey = `v3:${target.shortcut}:${target.paneId}:${imageWidth}:${imageHeight}:${color.join(",")}`;
  let dataBase64 = getCachedHintBase64(cacheKey, env);
  if (!dataBase64) {
    dataBase64 = createHintPngBase64(target.shortcut, imageWidth, imageHeight, color, target.paneId);
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

module.exports = {
  HINT_COLORS,
  colorForIndex,
  createHintPngBase64,
  createOverlayParams,
  encodePngRgba,
  getCachedCellSize,
  getCachedHintBase64,
  setCachedCellSize,
};
