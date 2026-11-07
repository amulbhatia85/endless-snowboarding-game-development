/**
 * Phase 10A — minimal Canvas2D rasterizer + PNG encoder for visual audits.
 *
 * Node has no DOM canvas here, so this replays the *actual* draw-call stream
 * the engine issues (same context API surface) into a pixel buffer and
 * encodes it as PNG (zlib deflate, filter 0). Approximations, documented so
 * no visual claim overstates fidelity:
 *   - quadratic/bézier curves are flattened to polylines (12 subdivisions);
 *   - strokes are rendered as round-cap capsules along the polyline;
 *   - shadowBlur is approximated by a multi-draw halo for drawImage only
 *     (shadowed path fills render without their blur);
 *   - fillText/strokeText render nothing (HUD lives in the DOM anyway).
 * Everything else (transforms, alpha, gradients, polygon fills) is computed
 * per-pixel from the same numbers the browser would use.
 */
import { deflateSync } from 'node:zlib';

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)));

export function parseColor(color) {
  if (typeof color !== 'string') return null;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 255 };
    }
    if (hex.length >= 6) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255 };
    }
    return null;
  }
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((part) => parseFloat(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? Math.round(parts[3] * 255) : 255 };
  }
  return null;
}

class Gradient {
  constructor(kind, x0, y0, x1, y1, r0 = 0, r1 = 0) {
    this.kind = kind;
    this.x0 = x0; this.y0 = y0;
    this.x1 = x1; this.y1 = y1;
    this.r0 = r0; this.r1 = r1;
    this.stops = [];
  }

  addColorStop(offset, color) {
    this.stops.push({ offset: Math.max(0, Math.min(1, offset)), color: parseColor(color) ?? { r: 0, g: 0, b: 0, a: 255 } });
    this.stops.sort((a, b) => a.offset - b.offset);
  }

  colorAt(x, y) {
    let t;
    if (this.kind === 'linear') {
      const dx = this.x1 - this.x0;
      const dy = this.y1 - this.y0;
      const lengthSquared = dx * dx + dy * dy;
      t = lengthSquared > 0 ? ((x - this.x0) * dx + (y - this.y0) * dy) / lengthSquared : 1;
    } else {
      const distance = Math.hypot(x - this.x0, y - this.y0);
      const span = this.r1 - this.r0;
      t = span > 0 ? (distance - this.r0) / span : distance > 0 ? 1 : 0;
    }
    t = Math.max(0, Math.min(1, t));
    if (!this.stops.length) return { r: 0, g: 0, b: 0, a: 255 };
    if (t <= this.stops[0].offset) return this.stops[0].color;
    for (let index = 1; index < this.stops.length; index += 1) {
      if (t <= this.stops[index].offset) {
        const a = this.stops[index - 1];
        const b = this.stops[index];
        const span = b.offset - a.offset || 1;
        const mix = (t - a.offset) / span;
        return {
          r: a.color.r + (b.color.r - a.color.r) * mix,
          g: a.color.g + (b.color.g - a.color.g) * mix,
          b: a.color.b + (b.color.b - a.color.b) * mix,
          a: a.color.a + (b.color.a - a.color.a) * mix,
        };
      }
    }
    return this.stops[this.stops.length - 1].color;
  }
}

class RasterContext {
  constructor(width, height) {
    this.canvas = { width, height };
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    // Start opaque as with `getContext('2d', { alpha: false })`.
    for (let index = 3; index < this.data.length; index += 4) this.data[index] = 255;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.font = '10px system-ui';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.transform = [1, 0, 0, 1, 0, 0];
    this.stack = [];
    this.path = [];
    this.operations = 0;
  }

  // ── state ──
  save() { this.stack.push({ transform: [...this.transform], alpha: this.globalAlpha, fill: this.fillStyle, stroke: this.strokeStyle, lineWidth: this.lineWidth }); this.operations += 1; }
  restore() { const state = this.stack.pop(); if (state) { this.transform = state.transform; this.globalAlpha = state.alpha; this.fillStyle = state.fill; this.strokeStyle = state.stroke; this.lineWidth = state.lineWidth; } this.operations += 1; }
  setTransform(a, b, c, d, e, f) { this.transform = [a, b, c, d, e, f]; }
  translate(x, y) { const [a, b, c, d, e, f] = this.transform; this.transform = [a, b, c, d, a * x + c * y + e, b * x + d * y + f]; }
  scale(x, y) { const [a, b, c, d, e, f] = this.transform; this.transform = [a * x, b * x, c * y, d * y, e, f]; }
  rotate(angle) { const cos = Math.cos(angle); const sin = Math.sin(angle); const [a, b, c, d, e, f] = this.transform; this.transform = [a * cos + c * sin, b * cos + d * sin, -a * sin + c * cos, -b * sin + d * cos, e, f]; }

  // ── gradients ──
  createLinearGradient(x0, y0, x1, y1) { this.operations += 1; return new Gradient('linear', x0, y0, x1, y1); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { this.operations += 1; return new Gradient('radial', x0, y0, x1, y1, r0, r1); }

  // ── path ──
  beginPath() { this.path = []; this.operations += 1; }
  closePath() { if (this.path.length) this.path.push({ ...this.path[this.pathStartIndex ?? 0], close: true }); }
  moveTo(x, y) { this.path.push({ x, y, move: true }); this.pathStartIndex = this.path.length - 1; }
  lineTo(x, y) { this.path.push({ x, y }); }
  quadraticCurveTo(cx, cy, x, y) { this.flattenCurve([this.lastPoint(), { x: cx, y: cy }, { x, y }], (t, p0, p1, p2) => ({
    x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  })); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this.flattenCurve([this.lastPoint(), { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x, y }], (t, p0, p1, p2, p3) => ({
    x: (1 - t) ** 3 * p0.x + 3 * (1 - t) ** 2 * t * p1.x + 3 * (1 - t) * t * t * p2.x + t ** 3 * p3.x,
    y: (1 - t) ** 3 * p0.y + 3 * (1 - t) ** 2 * t * p1.y + 3 * (1 - t) * t * t * p2.y + t ** 3 * p3.y,
  })); }
  arc(x, y, radius, startAngle = 0, endAngle = Math.PI * 2) {
    const count = Math.max(6, Math.ceil(Math.abs(endAngle - startAngle) * radius));
    for (let index = 0; index <= count; index += 1) {
      const angle = startAngle + (endAngle - startAngle) * (index / count);
      this.path.push({ x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius });
    }
  }
  ellipse(x, y, radiusX, radiusY, rotation = 0, startAngle = 0, endAngle = Math.PI * 2) {
    const count = Math.max(6, Math.ceil(Math.abs(endAngle - startAngle) * Math.max(radiusX, radiusY)));
    for (let index = 0; index <= count; index += 1) {
      const angle = startAngle + (endAngle - startAngle) * (index / count);
      const px = Math.cos(angle) * radiusX;
      const py = Math.sin(angle) * radiusY;
      this.path.push({ x: x + px * Math.cos(rotation) - py * Math.sin(rotation), y: y + px * Math.sin(rotation) + py * Math.cos(rotation) });
    }
  }
  rect(x, y, width, height) { this.moveTo(x, y); this.lineTo(x + width, y); this.lineTo(x + width, y + height); this.lineTo(x, y + height); this.closePath(); }

  lastPoint() { return this.path.length ? this.path[this.path.length - 1] : { x: 0, y: 0 }; }
  flattenCurve(points, sample) {
    for (let step = 1; step <= 12; step += 1) {
      const point = sample(step / 12, ...points);
      this.path.push(point);
    }
  }

  // ── raster ops ──
  clearRect(x, y, width, height) {
    this.operations += 1;
    this.blendRect(x, y, width, height, { r: 0, g: 0, b: 0, a: 0 }, true);
  }
  fillRect(x, y, width, height) {
    this.operations += 1;
    this.blendRect(x, y, width, height, this.fillStyleValue());
  }
  fill() { this.operations += 1; this.fillPathWith(this.fillStyleValue()); }
  stroke() { this.operations += 1; this.strokePathWith(this.strokeStyleValue(), this.lineWidth); }
  fillText() { this.operations += 1; }
  strokeText() { this.operations += 1; }
  drawImage(source, dx, dy) {
    this.operations += 1;
    if (!(source instanceof RasterContext)) return;
    // Approximate the glow's shadowBlur with repeated low-alpha offsets.
    const passes = this.shadowBlur > 0 ? 3 : 1;
    const offset = this.shadowBlur > 0 ? this.shadowBlur / 2 : 0;
    for (let pass = 0; pass < passes; pass += 1) {
      const angle = (pass / passes) * Math.PI * 2;
      this.blit(source, dx + Math.cos(angle) * offset, dy + Math.sin(angle) * offset, this.globalAlpha / passes);
    }
  }

  fillStyleValue() { return this.fillStyle instanceof Gradient ? this.fillStyle : parseColor(this.fillStyle) ?? { r: 0, g: 0, b: 0, a: 255 }; }
  strokeStyleValue() { return this.strokeStyle instanceof Gradient ? this.strokeStyle : parseColor(this.strokeStyle) ?? { r: 0, g: 0, b: 0, a: 255 }; }

  toScreen(x, y) {
    const [a, b, c, d, e, f] = this.transform;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  blendRect(x, y, width, height, color, clear = false) {
    const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => this.toScreen(px, py));
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    // Axis-aligned fast path (all engine rects are).
    if (this.transform[1] === 0 && this.transform[2] === 0) {
      const left = Math.max(0, Math.floor(Math.min(...xs)));
      const right = Math.min(this.width - 1, Math.ceil(Math.max(...xs)));
      const top = Math.max(0, Math.floor(Math.min(...ys)));
      const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
      for (let py = top; py <= bottom; py += 1) {
        for (let px = left; px <= right; px += 1) {
          const paint = color instanceof Gradient ? color.colorAt(px, py) : color;
          this.blendPixel(px, py, paint, clear);
        }
      }
    }
  }

  fillPathWith(paint) {
    if (this.path.length < 3) return;
    const screenPath = this.path.map((point) => this.toScreen(point.x, point.y));
    const ys = screenPath.map((point) => point[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let py = top; py <= bottom; py += 1) {
      const crossings = [];
      for (let index = 0; index < screenPath.length - 1; index += 1) {
        const a = screenPath[index];
        const b = screenPath[index + 1];
        // A segment whose endpoint is a moveTo starts a new subpath — the
        // connector from the previous subpath is not an edge (browser
        // semantics). Phase 10C: the flag lives on the original path points,
        // not on the transformed pairs.
        if (this.path[index + 1].move) continue;
        if ((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) {
          crossings.push(a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      crossings.sort((m, n) => m - n);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const left = Math.max(0, Math.ceil(crossings[pair]));
        const right = Math.min(this.width - 1, Math.floor(crossings[pair + 1]));
        for (let px = left; px <= right; px += 1) {
          const color = paint instanceof Gradient ? paint.colorAt(px, py) : paint;
          this.blendPixel(px, py, color);
        }
      }
    }
  }

  strokePathWith(paint, width) {
    if (this.path.length < 2) return;
    const radius = Math.max(0.5, width / 2);
    for (let index = 0; index < this.path.length - 1; index += 1) {
      const a = this.path[index];
      const b = this.path[index + 1];
      if (b.move) continue;
      const start = this.toScreen(a.x, a.y);
      const end = this.toScreen(b.x, b.y);
      const minX = Math.max(0, Math.floor(Math.min(start[0], end[0]) - radius));
      const maxX = Math.min(this.width - 1, Math.ceil(Math.max(start[0], end[0]) + radius));
      const minY = Math.max(0, Math.floor(Math.min(start[1], end[1]) - radius));
      const maxY = Math.min(this.height - 1, Math.ceil(Math.max(start[1], end[1]) + radius));
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const lengthSquared = dx * dx + dy * dy || 1;
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          const t = Math.max(0, Math.min(1, ((px - start[0]) * dx + (py - start[1]) * dy) / lengthSquared));
          const distance = Math.hypot(px - (start[0] + dx * t), py - (start[1] + dy * t));
          if (distance <= radius) {
            const color = paint instanceof Gradient ? paint.colorAt(px, py) : paint;
            const coverage = Math.max(0.35, 1 - Math.max(0, distance - radius + 1));
            this.blendPixel(px, py, color, false, coverage);
          }
        }
      }
    }
  }

  blendPixel(px, py, color, clear = false, coverage = 1) {
    const alpha = clamp255((color.a / 255) * this.globalAlpha * coverage * 255);
    if (alpha <= 0) return;
    const index = (py * this.width + px) * 4;
    if (clear || alpha >= 254) {
      this.data[index] = clamp255(color.r);
      this.data[index + 1] = clamp255(color.g);
      this.data[index + 2] = clamp255(color.b);
      this.data[index + 3] = clear ? 0 : 255;
      return;
    }
    const existing = this.data[index + 3] / 255;
    const added = alpha / 255;
    const combined = added + existing * (1 - added);
    if (combined <= 0) return;
    this.data[index] = clamp255((color.r * added + this.data[index] * existing * (1 - added)) / combined);
    this.data[index + 1] = clamp255((color.g * added + this.data[index + 1] * existing * (1 - added)) / combined);
    this.data[index + 2] = clamp255((color.b * added + this.data[index + 2] * existing * (1 - added)) / combined);
    this.data[index + 3] = clamp255(combined * 255);
  }
}

// ── PNG encoding ──
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(context) {
  const { width, height, data } = context;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A DOM-ish canvas whose 2d context is the rasterizer. Drop-in for the
 * engine's `document.createElement('canvas')` and constructor canvas.
 */
export function rasterCanvas(width, height) {
  const context = new RasterContext(width, height);
  return {
    width,
    height,
    getContext: () => context,
    getBoundingClientRect: () => ({ width, height }),
  };
}

export { RasterContext };
