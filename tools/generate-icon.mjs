/**
 * Draws the extension's marketplace icon.
 *
 * Kept in the repo so the asset is reproducible rather than a binary nobody can
 * regenerate. Writes a 128x128 PNG with no dependencies: the shapes are
 * rasterised with 4x supersampling for clean edges, then encoded by hand.
 *
 *   node tools/generate-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const SIZE = 128;
const SUPERSAMPLE = 4;

// A chevron pointing at a target: "jump to the definition".
const BACKGROUND_TOP = [0x6c, 0x4b, 0xf6];
const BACKGROUND_BOTTOM = [0x2f, 0x6f, 0xed];
const FOREGROUND = [0xff, 0xff, 0xff];

const CHEVRON = {
  upper: [
    [46, 42],
    [70, 64],
  ],
  lower: [
    [46, 86],
    [70, 64],
  ],
  halfWidth: 6.5,
};
const TARGET = { center: [93, 64], radius: 7.5 };
const PANEL = { inset: 7, radius: 27 };

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Signed distance to a rounded rectangle; negative inside. */
function distanceToPanel(px, py) {
  const half = SIZE / 2 - PANEL.inset;
  const r = PANEL.radius;
  const qx = Math.abs(px - SIZE / 2) - (half - r);
  const qy = Math.abs(py - SIZE / 2) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sampleIsInsidePanel(px, py) {
  return distanceToPanel(px, py) <= 0;
}

function sampleIsInsideMark(px, py) {
  if (distanceToSegment(px, py, ...CHEVRON.upper) <= CHEVRON.halfWidth) {
    return true;
  }
  if (distanceToSegment(px, py, ...CHEVRON.lower) <= CHEVRON.halfWidth) {
    return true;
  }
  return Math.hypot(px - TARGET.center[0], py - TARGET.center[1]) <= TARGET.radius;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const step = 1 / SUPERSAMPLE;
const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let panelHits = 0;
    let markHits = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      for (let sx = 0; sx < SUPERSAMPLE; sx++) {
        const px = x + (sx + 0.5) * step;
        const py = y + (sy + 0.5) * step;
        if (sampleIsInsidePanel(px, py)) {
          panelHits++;
          if (sampleIsInsideMark(px, py)) {
            markHits++;
          }
        }
      }
    }
    const panelCoverage = panelHits / samplesPerPixel;
    const markCoverage = markHits / samplesPerPixel;

    const gradient = y / (SIZE - 1);
    const background = BACKGROUND_TOP.map((c, i) => c + (BACKGROUND_BOTTOM[i] - c) * gradient);
    // Composite the mark over the panel, then the panel over transparency.
    const blend = background.map((c, i) => c + (FOREGROUND[i] - c) * (panelCoverage > 0 ? markCoverage / Math.max(panelCoverage, 1e-6) : 0));

    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(Math.max(0, Math.min(255, blend[0])));
    pixels[offset + 1] = Math.round(Math.max(0, Math.min(255, blend[1])));
    pixels[offset + 2] = Math.round(Math.max(0, Math.min(255, blend[2])));
    pixels[offset + 3] = Math.round(panelCoverage * 255);
  }
}

writeFileSync('icon.png', encodePng(pixels, SIZE, SIZE));
console.log(`wrote icon.png (${SIZE}x${SIZE})`);

// --- PNG encoding ---------------------------------------------------------

function encodePng(rgba, width, height) {
  // Each scanline is prefixed with its filter type; 0 means "no filtering".
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
