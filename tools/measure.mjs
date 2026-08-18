#!/usr/bin/env node
/**
 * Frame measurement.
 *
 * Reviews of this project kept turning on numbers — is the ground brighter than the
 * hero, is the far plane actually hazier than the near one, how much of the frame is
 * crushed to black — and every reviewer was reinventing a PNG decoder to get them.
 * Worse, several rounds were argued on impressions because getting a number was
 * inconvenient, and at least one confident numeric claim turned out to be measuring
 * something other than what it named.
 *
 * So: one decoder, one set of definitions, checked in.
 *
 * Usage:
 *   node tools/measure.mjs shots/r9a-heavy.png
 *   node tools/measure.mjs shots/a.png --rect hero=760,420,240,220 --rect road=300,600,300,140
 *   node tools/measure.mjs shots/a.png --json
 */
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* ---------------- minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) --------- */

export function decodePNG(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8;
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
  }
  return { width: w, height: h, channels, data: out };
}

/** Rec. 709 relative luminance on the sRGB-encoded values, 0..255. */
export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function rectStats(img, x0, y0, rw, rh) {
  const { width, height, channels, data } = img;
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  const x1 = Math.min(width, x0 + rw);
  const y1 = Math.min(height, y0 + rh);
  let n = 0, sum = 0, sum2 = 0, min = 255, max = 0;
  let rs = 0, gs = 0, bs = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * channels;
      const l = lum(data[o], data[o + 1], data[o + 2]);
      sum += l; sum2 += l * l; n++;
      if (l < min) min = l;
      if (l > max) max = l;
      rs += data[o]; gs += data[o + 1]; bs += data[o + 2];
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return {
    mean: +mean.toFixed(2),
    stdev: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2),
    min: +min.toFixed(1),
    max: +max.toFixed(1),
    rgb: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)],
    px: n,
  };
}

export function frameStats(img) {
  const { width, height, channels, data } = img;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    hist[Math.round(lum(data[o], data[o + 1], data[o + 2]))]++;
    n++;
  }
  let crushed = 0, clipped = 0, sum = 0;
  for (let v = 0; v < 256; v++) {
    sum += v * hist[v];
    if (v < 8) crushed += hist[v];
    if (v > 250) clipped += hist[v];
  }
  // Percentile spread: how much of the tonal range the frame actually occupies.
  const pct = (t) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * t) return v; }
    return 255;
  };
  return {
    mean: +(sum / n).toFixed(2),
    crushedPct: +((crushed / n) * 100).toFixed(2),
    clippedPct: +((clipped / n) * 100).toFixed(2),
    p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
  };
}

/**
 * Split the frame into horizontal bands and report each band's mean. On a quarter
 * view the top bands are sky and distant city, the bottom bands are near ground, so
 * a monotonic read here is the quickest test of whether aerial perspective exists.
 */
export function bands(img, n = 6) {
  const h = Math.floor(img.height / n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rectStats(img, 0, i * h, img.width, h).mean);
  return out;
}


/* ---------------- minimal PNG encoder, for crops ---------------- */

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
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function writePNG(path, width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/**
 * Nearest-neighbour crop-and-magnify.
 *
 * Judging a 40 px contact shadow from a 1600 px frame is guesswork, and guesswork is
 * how this project once concluded a working effect was broken. Nearest-neighbour is
 * deliberate: interpolation would invent gradients that are not in the render.
 */
export function crop(img, x0, y0, w, h, scale = 1) {
  const ow = w * scale;
  const oh = h * scale;
  const out = Buffer.alloc(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale));
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale));
      const so = (sy * img.width + sx) * img.channels;
      const dofs = (y * ow + x) * 3;
      out[dofs] = img.data[so];
      out[dofs + 1] = img.data[so + 1];
      out[dofs + 2] = img.data[so + 2];
    }
  }
  return { width: ow, height: oh, data: out };
}

/**
 * Where the black is.
 *
 * A whole-frame "26% below luminance 8" is a number you cannot act on — it does not
 * say whether the crush is one large unlit wall, a hundred hard-edged decals, or the
 * gaps between window lights. This prints the same statistic on a coarse grid so the
 * offending region can be located and then measured directly.
 */
export function crushGrid(img, cols = 10, rows = 6) {
  const cw = Math.floor(img.width / cols);
  const ch = Math.floor(img.height / rows);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      let n = 0, dark = 0;
      for (let y = r * ch; y < (r + 1) * ch; y++) {
        for (let x = c * cw; x < (c + 1) * cw; x++) {
          const o = (y * img.width + x) * img.channels;
          if (lum(img.data[o], img.data[o + 1], img.data[o + 2]) < 8) dark++;
          n++;
        }
      }
      line.push(Math.round((dark / n) * 100));
    }
    out.push(line);
  }
  return out;
}

/**
 * Paint every crushed pixel magenta over a dimmed copy of the frame.
 *
 * A crush percentage says how much; a grid says roughly where; neither says WHAT.
 * Three consecutive hypotheses about the largest black mass in this scene — the
 * terrace, the foreground band, the corridor flanks' cast shadow — were each
 * plausible, each acted on, and each wrong, at a capture apiece. Looking at the mask
 * settles it in one.
 */
export function crushMask(img, threshold = 8) {
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * img.channels;
    const l = lum(img.data[o], img.data[o + 1], img.data[o + 2]);
    const d = i * 3;
    if (l < threshold) {
      out[d] = 255; out[d + 1] = 0; out[d + 2] = 200;
    } else {
      out[d] = img.data[o] * 0.45;
      out[d + 1] = img.data[o + 1] * 0.45;
      out[d + 2] = img.data[o + 2] * 0.45;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/* ---------------- CLI ---------------- */

if (process.argv[1] && process.argv[1].endsWith('measure.mjs')) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--') && !/^\w+=/.test(a));
  const rects = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rect') {
      const [name, spec] = args[i + 1].split('=');
      const [x, y, w, h] = spec.split(',').map(Number);
      rects.push({ name, x, y, w, h });
    }
  }
  const asJson = args.includes('--json');
  const crops = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--crop') {
      const [name, spec] = args[i + 1].split('=');
      const [x, y, w, h, sc] = spec.split(',').map(Number);
      crops.push({ name, x, y, w, h, sc: sc || 1 });
    }
  }
  const report = {};
  for (const f of files) {
    const img = decodePNG(f);
    const r = { size: [img.width, img.height], frame: frameStats(img), bands: bands(img) };
    for (const q of rects) r[q.name] = rectStats(img, q.x, q.y, q.w, q.h);
    for (const q of crops) {
      const c = crop(img, q.x, q.y, q.w, q.h, q.sc);
      const out = `shots/crop-${q.name}.png`;
      writePNG(out, c.width, c.height, c.data);
      if (!asJson) console.log(`  crop -> ${out}  (${c.width}x${c.height})`);
    }
    report[f] = r;
    if (!asJson) {
      console.log(`\n${f}  ${img.width}x${img.height}`);
      const s = r.frame;
      console.log(`  mean ${s.mean}   crushed<8 ${s.crushedPct}%   clipped>250 ${s.clippedPct}%`);
      console.log(`  percentiles  p01 ${s.p01}  p05 ${s.p05}  p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}`);
      console.log(`  bands (top->bottom) ${r.bands.join('  ')}`);
      if (args.includes('--mask')) {
        const m = crushMask(img);
        const out = `shots/mask-${f.split('/').pop()}`;
        writePNG(out, m.width, m.height, m.data);
        console.log(`  crush mask -> ${out}`);
      }
      if (args.includes('--crush')) {
        console.log('  crushed% grid (each cell = frame/10 wide, frame/6 tall):');
        for (const line of crushGrid(img)) {
          console.log('    ' + line.map((v) => String(v).padStart(4)).join(''));
        }
      }
      for (const q of rects) {
        const v = r[q.name];
        console.log(`  ${q.name.padEnd(12)} mean ${String(v.mean).padStart(7)}  sd ${String(v.stdev).padStart(6)}  rgb ${v.rgb.join(',')}`);
      }
    }
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
}
