/**
 * Generates the app icon set.
 *
 * The mark is a globe (the web the agent drives) with one filled node breaking
 * its ring (the agent acting on it), drawn to the same strictly monochrome
 * rules as the rest of the app. Everything is rasterised here rather than
 * committed as opaque binaries, so the icon can be re-tuned by changing
 * numbers instead of re-exporting art.
 *
 *   node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INK = [10, 10, 10];
const WHITE = [255, 255, 255];

/* --------------------------------- PNG out -------------------------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder — enough for flat art, no interlacing. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- drawing -------------------------------- */

/**
 * Signed distance for the mark, in pixels. Negative is inside the glyph.
 * `s` scales every dimension so one definition serves every output size.
 */
function glyphDistance(x, y, cx, cy, s) {
  const dx = x - cx;
  const dy = y - cy;

  const R = 300 * s;          // globe radius
  const stroke = 58 * s;      // ring weight
  const rx = 136 * s;         // meridian half-width
  const nodeR = 88 * s;       // agent node
  const gap = 34 * s;         // clearance punched around the node

  const r = Math.hypot(dx, dy);

  // Ring: distance to the circle outline.
  let d = Math.abs(r - R) - stroke / 2;

  // Meridian ellipse, clipped to the globe.
  const f = Math.hypot(dx / rx, dy / R);
  // abs() is what makes this an outline; without it the whole ellipse fills.
  const meridian = Math.max(
    Math.abs(f - 1) * Math.min(rx, R) - stroke * 0.42,
    r - R - stroke / 2
  );
  d = Math.min(d, meridian);

  // Equator bar, clipped to the globe.
  const equator = Math.max(Math.abs(dy) - stroke * 0.42, r - R - stroke / 2);
  d = Math.min(d, equator);

  // Punch a gap so the node reads as a separate element sitting on the ring.
  const nx = cx + R * Math.SQRT1_2;
  const ny = cy - R * Math.SQRT1_2;
  const nodeDist = Math.hypot(x - nx, y - ny);
  d = Math.max(d, -(nodeDist - (nodeR + gap)));

  // Then draw the node itself.
  return Math.min(d, nodeDist - nodeR);
}

/**
 * Renders the mark with 3x3 supersampling.
 * `bg` of null leaves the background transparent (Android adaptive foreground).
 */
function render(size, { fg, bg, scale = 1 }) {
  const out = Buffer.alloc(size * size * 4);
  const s = (size / 1024) * scale;
  const c = size / 2;
  const SS = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (glyphDistance(px, py, c, c, s) <= 0) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (y * size + x) * 4;

      if (bg) {
        // Composite the glyph over an opaque background.
        for (let k = 0; k < 3; k++) out[i + k] = Math.round(bg[k] * (1 - a) + fg[k] * a);
        out[i + 3] = 255;
      } else {
        for (let k = 0; k < 3; k++) out[i + k] = fg[k];
        out[i + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

/* --------------------------------- outputs -------------------------------- */

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

const targets = [
  // Store / launcher icon: white mark on ink.
  { file: 'icon.png', size: 1024, opts: { fg: WHITE, bg: INK } },
  // Android adaptive foreground: transparent, inside the 66% safe zone.
  { file: 'adaptive-icon.png', size: 1024, opts: { fg: WHITE, bg: null, scale: 0.62 } },
  // Splash: ink mark on the white app canvas.
  { file: 'splash-icon.png', size: 512, opts: { fg: INK, bg: WHITE } },
  // Monochrome status-bar notification icon: white on transparent.
  { file: 'notification-icon.png', size: 192, opts: { fg: WHITE, bg: null, scale: 0.86 } },
  { file: 'favicon.png', size: 64, opts: { fg: WHITE, bg: INK } },
];

for (const { file, size, opts } of targets) {
  const png = encodePng(size, size, render(size, opts));
  fs.writeFileSync(path.join(assets, file), png);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log('\nIcons written to assets/');
