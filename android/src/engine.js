// PhotoEditor image engine for the Android app (runs in a Web Worker).
//
// A JavaScript port of editor.py: the same operation list (rotate, flip, crop,
// resize, filter, liquify) and slider adjustments (including noise reduction),
// applied to the original photo on the phone, so the app works offline.
// Images are {w, h, d: Uint8ClampedArray RGBA, alpha: bool}.
"use strict";

const PREVIEW_CACHE = 6;

let full = null;          // original photo
let previewBase = null;   // { img, scale, maxSide }
const maps = new Map();   // liquify map id -> field
const geoCache = new Map(); // JSON(ops)|maxSide -> { img, scale }
let nextMap = 1;

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const newImg = (w, h, alpha) => ({ w, h, d: new Uint8ClampedArray(w * h * 4), alpha });
const cloneImg = (im) => ({ w: im.w, h: im.h, d: new Uint8ClampedArray(im.d), alpha: im.alpha });

function toCanvas(im) {
  const c = new OffscreenCanvas(im.w, im.h);
  c.getContext("2d").putImageData(new ImageData(im.d, im.w, im.h), 0, 0);
  return c;
}
function fromCanvas(c, alpha) {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const im = { w: c.width, h: c.height, d, alpha };
  if (!alpha) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return im;
}

// ---------------------------------------------------------------- blur
// Gaussian blur like Pillow: three extended box blurs with a fractional radius.
function boxRadius(sigma, passes) {
  const s2 = (sigma * sigma) / passes;
  const L = Math.sqrt(12 * s2 + 1);
  const l = Math.floor((L - 1) / 2);
  const a = ((2 * l + 1) * (l * (l + 1) - 3 * s2)) / (6 * (s2 - (l + 1) * (l + 1)));
  return [l, a];
}
function boxLine(src, dst, n, l, a) {
  const inv = 1 / (2 * l + 1 + 2 * a), last = n - 1;
  const at = (i) => src[i < 0 ? 0 : i > last ? last : i];
  let s = 0;
  for (let k = -l; k <= l; k++) s += at(k);
  for (let i = 0; i < n; i++) {
    dst[i] = (s + a * (at(i - l - 1) + at(i + l + 1))) * inv;
    s += at(i + l + 1) - at(i - l);
  }
}
/** Blur one plane (Float32Array w*h) in place. */
function blurPlane(p, w, h, sigma) {
  if (sigma <= 0) return p;
  const [l, a] = boxRadius(sigma, 3);
  const n = Math.max(w, h);
  let b1 = new Float32Array(n), b2 = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = p.subarray(y * w, y * w + w);
    b1.set(row);
    for (let k = 0; k < 3; k++) { boxLine(b1, b2, w, l, a); [b1, b2] = [b2, b1]; }
    row.set(b1.subarray(0, w));
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) b1[y] = p[y * w + x];
    for (let k = 0; k < 3; k++) { boxLine(b1, b2, h, l, a); [b1, b2] = [b2, b1]; }
    for (let y = 0; y < h; y++) p[y * w + x] = b1[y];
  }
  return p;
}
function channel(im, c) {
  const p = new Float32Array(im.w * im.h), d = im.d;
  for (let i = 0, j = c; i < p.length; i++, j += 4) p[i] = d[j];
  return p;
}
function setChannel(im, c, p) {
  const d = im.d;
  for (let i = 0, j = c; i < p.length; i++, j += 4) d[j] = Math.round(p[i]);
}
function gaussian(im, sigma) {
  const out = cloneImg(im);
  for (let c = 0; c < 3; c++) setChannel(out, c, blurPlane(channel(im, c), im.w, im.h, sigma));
  return out;
}
function blurU8(plane, w, h, sigma) {
  const p = Float32Array.from(plane);
  blurPlane(p, w, h, sigma);
  const o = new Uint8ClampedArray(p.length);
  for (let i = 0; i < p.length; i++) o[i] = Math.round(p[i]);
  return o;
}
/** Pillow's UnsharpMask on a uint8 plane. */
function unsharpPlane(plane, w, h, radius, percent, threshold) {
  const blur = blurU8(plane, w, h, radius);
  const out = new Uint8ClampedArray(plane.length);
  for (let i = 0; i < plane.length; i++) {
    const diff = plane[i] - blur[i];
    out[i] = Math.abs(diff) >= threshold ? plane[i] + (diff * percent) / 100 : plane[i];
  }
  return out;
}

// ---------------------------------------------------------------- kernels
// Pillow applies kernel row j to the image row y+1-j and column i to x+i-1, and keeps the border.
function convolve(im, size, k, scale, offset) {
  const { w, h, d } = im, out = cloneImg(im), o = out.d, r = (size - 1) / 2;
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      let s0 = 0, s1 = 0, s2 = 0;
      for (let j = 0; j < size; j++) {
        const yy = y + r - j;
        for (let i = 0; i < size; i++) {
          const kv = k[j * size + i];
          if (!kv) continue;
          const q = (yy * w + x + i - r) * 4;
          s0 += d[q] * kv; s1 += d[q + 1] * kv; s2 += d[q + 2] * kv;
        }
      }
      const p = (y * w + x) * 4;
      o[p] = s0 / scale + offset; o[p + 1] = s1 / scale + offset; o[p + 2] = s2 / scale + offset;
    }
  }
  return out;
}
const K_EDGES = [-1, -1, -1, -1, 8, -1, -1, -1, -1];
const K_EMBOSS = [-1, 0, 0, 0, 1, 0, 0, 0, 0];
const K_SMOOTH = [1, 1, 1, 1, 5, 1, 1, 1, 1];
const K_SMOOTH_MORE = [1, 1, 1, 1, 1, 1, 5, 5, 5, 1, 1, 5, 44, 5, 1, 1, 5, 5, 5, 1, 1, 1, 1, 1, 1];

// ---------------------------------------------------------------- per-pixel helpers
function mapLut(im, luts) {
  const out = cloneImg(im), d = out.d;
  for (let i = 0; i < d.length; i += 4) { d[i] = luts[0][d[i]]; d[i + 1] = luts[1][d[i + 1]]; d[i + 2] = luts[2][d[i + 2]]; }
  return out;
}
const lum = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;   // Pillow "L"
function histograms(im) {
  const hs = [new Float64Array(256), new Float64Array(256), new Float64Array(256)], d = im.d;
  for (let i = 0; i < d.length; i += 4) { hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; }
  return hs;
}
function autocontrastLut(h, cutoff) {
  h = Float64Array.from(h);
  const n = h.reduce((a, b) => a + b, 0);
  let cut = Math.floor((n * cutoff) / 100);
  for (let lo = 0; lo < 256 && cut > 0; lo++) { if (cut > h[lo]) { cut -= h[lo]; h[lo] = 0; } else { h[lo] -= cut; cut = 0; } }
  cut = Math.floor((n * cutoff) / 100);
  for (let hi = 255; hi >= 0 && cut > 0; hi--) { if (cut > h[hi]) { cut -= h[hi]; h[hi] = 0; } else { h[hi] -= cut; cut = 0; } }
  let lo = 0; while (lo < 256 && !h[lo]) lo++;
  let hi = 255; while (hi >= 0 && !h[hi]) hi--;
  const lut = new Uint8ClampedArray(256);
  if (hi <= lo) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  const scale = 255 / (hi - lo), offset = -lo * scale;
  for (let i = 0; i < 256; i++) lut[i] = Math.trunc(i * scale + offset);
  return lut;
}
function equalizeLut(h) {
  const lut = new Uint8ClampedArray(256);
  const nz = [...h].filter((x) => x);
  let step = nz.length > 1 ? Math.floor((nz.reduce((a, b) => a + b, 0) - nz[nz.length - 1]) / 255) : 0;
  if (!step) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  let n = Math.floor(step / 2);
  for (let i = 0; i < 256; i++) { lut[i] = Math.floor(n / step); n += h[i]; }
  return lut;
}
function sepiaLuts() {
  const black = [0x2b, 0x1d, 0x0e], mid = [0xa6, 0x7c, 0x52], white = [0xff, 0xf4, 0xe0];
  return [0, 1, 2].map((c) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 127; i++) lut[i] = black[c] + Math.floor((i * (mid[c] - black[c])) / 127);
    for (let i = 0; i < 128; i++) lut[127 + i] = mid[c] + Math.floor((i * (white[c] - mid[c])) / 128);
    lut[255] = white[c];
    return lut;
  });
}

// ---------------------------------------------------------------- filters
function applyFilter(im, name, strength = 1) {
  const d0 = im.d;
  switch (name) {
    case "grayscale": {
      const out = cloneImg(im), d = out.d;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d0[i], d0[i + 1], d0[i + 2]);
      return out;
    }
    case "sepia": {
      const luts = sepiaLuts(), out = cloneImg(im), d = out.d;
      for (let i = 0; i < d.length; i += 4) {
        const g = lum(d0[i], d0[i + 1], d0[i + 2]);
        d[i] = luts[0][g]; d[i + 1] = luts[1][g]; d[i + 2] = luts[2][g];
      }
      return out;
    }
    case "invert": {
      const out = cloneImg(im), d = out.d;
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
      return out;
    }
    case "blur": return gaussian(im, Math.max(0.5, 3 * strength));
    case "sharpen": {
      const out = cloneImg(im);
      for (let c = 0; c < 3; c++) {
        const p = Uint8ClampedArray.from(channel(im, c));
        const s = unsharpPlane(p, im.w, im.h, 2, Math.trunc(150 * strength), 3);
        for (let i = 0, j = c; i < s.length; i++, j += 4) out.d[j] = s[i];
      }
      return out;
    }
    case "edge": return convolve(im, 3, K_EDGES, 1, 0);
    case "emboss": return convolve(im, 3, K_EMBOSS, 1, 128);
    case "contour": return convolve(im, 3, K_EDGES, 1, 255);
    case "smooth": return convolve(im, 5, K_SMOOTH_MORE, 100, 0);
    case "autocontrast": return mapLut(im, histograms(im).map((h) => autocontrastLut(h, 1)));
    case "equalize": return mapLut(im, histograms(im).map(equalizeLut));
    case "posterize": { const l = new Uint8ClampedArray(256).map((_, i) => i & 0xe0); return mapLut(im, [l, l, l]); }
    case "vignette": {
      // Pillow's 256×256 radial gradient stretched over the photo; bright centre, dark (×0.15) edge
      const out = cloneImg(im), d = out.d, { w, h } = im;
      for (let y = 0; y < h; y++) {
        const v = ((y + 0.5) / h) * 256 - 0.5 - 128;
        for (let x = 0; x < w; x++) {
          const u = ((x + 0.5) / w) * 256 - 0.5 - 128;
          const p = Math.min(255, Math.sqrt(u * u + v * v) * Math.SQRT2);
          const m = (p < 90 ? 255 : Math.max(0, 255 - Math.trunc((p - 90) * 1.6))) / 255;
          if (m === 1) continue;
          const k = m + 0.15 * (1 - m), i = (y * w + x) * 4;
          d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
        }
      }
      return out;
    }
  }
  throw new Error("Unknown filter: " + name);
}

// ---------------------------------------------------------------- geometry
function rotateRight(im, turns) {        // turns of 90° counter-clockwise (Pillow ROTATE_90 = 1)
  const { w, h, d } = im;
  const swap = turns % 2 === 1;
  const out = newImg(swap ? h : w, swap ? w : h, im.alpha), o = new Uint32Array(out.d.buffer), s = new Uint32Array(d.buffer, d.byteOffset, w * h);
  const W = out.w, H = out.h;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sx, sy;
    if (turns === 1) { sx = w - 1 - y; sy = x; }
    else if (turns === 2) { sx = w - 1 - x; sy = h - 1 - y; }
    else { sx = y; sy = h - 1 - x; }
    o[y * W + x] = s[sy * w + sx];
  }
  return out;
}
function rotateFree(im, angle) {          // counter-clockwise degrees, expand, white (or transparent) fill
  // output size exactly as Pillow's rotate(expand=True) works it out
  const a = (angle * Math.PI) / 180, r15 = (v) => Math.round(v * 1e15) / 1e15;
  const cs = r15(Math.cos(-a)), sn = r15(Math.sin(-a)), cx = im.w / 2, cy = im.h / 2;
  const tx = cs * -cx + sn * -cy + cx, ty = -sn * -cx + cs * -cy + cy;
  const xs = [], ys = [];
  for (const [x, y] of [[0, 0], [im.w, 0], [im.w, im.h], [0, im.h]]) { xs.push(cs * x + sn * y + tx); ys.push(-sn * x + cs * y + ty); }
  const nw = Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs));
  const nh = Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys));
  const c = new OffscreenCanvas(nw, nh), ctx = c.getContext("2d");
  if (!im.alpha) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, nw, nh); }
  ctx.imageSmoothingQuality = "high";
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(-a);
  ctx.drawImage(toCanvas(im), -im.w / 2, -im.h / 2);
  return fromCanvas(c, im.alpha);
}
function flip(im, axis) {
  const { w, h } = im, out = newImg(w, h, im.alpha);
  const s = new Uint32Array(im.d.buffer, im.d.byteOffset, w * h), o = new Uint32Array(out.d.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    o[y * w + x] = axis === "h" ? s[y * w + (w - 1 - x)] : s[(h - 1 - y) * w + x];
  return out;
}
function crop(im, x0, y0, x1, y1) {
  const out = newImg(x1 - x0, y1 - y0, im.alpha);
  for (let y = y0; y < y1; y++) out.d.set(im.d.subarray((y * im.w + x0) * 4, (y * im.w + x1) * 4), (y - y0) * out.w * 4);
  return out;
}
function resize(im, tw, th) {
  if (tw === im.w && th === im.h) return im;
  let src = toCanvas(im), sw = im.w, sh = im.h;
  // big reductions in halving steps keep the result smooth (closer to Pillow's LANCZOS)
  while (sw / 2 >= tw && sh / 2 >= th) {
    const nw = Math.max(tw, Math.round(sw / 2)), nh = Math.max(th, Math.round(sh / 2));
    const c = new OffscreenCanvas(nw, nh), ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, nw, nh);
    src = c; sw = nw; sh = nh;
  }
  const c = new OffscreenCanvas(tw, th), ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, tw, th);
  return fromCanvas(c, im.alpha);
}

// ---------------------------------------------------------------- liquify
function makeMap(w, h, buf) {
  const data = new Int16Array(buf);
  if (data.length !== w * h * 2) throw new Error("Liquify data does not match its size");
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 2;
    if (data[i] || data[i + 1]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { w, h, data, bbox: x1 < 0 ? null : [x0, y0, x1, y1] };
}
/** Each output pixel p shows the source at p + D(p); D is scaled from the field to the photo size. */
function applyLiquify(im, m) {
  if (!m.bbox) return im;
  const { w: W, h: H, d: s } = im, kx = m.w / W, ky = m.h / H, f = m.data, fw = m.w, fh = m.h;
  const margin = 3;
  const X0 = Math.max(0, Math.floor(m.bbox[0] / kx) - margin), Y0 = Math.max(0, Math.floor(m.bbox[1] / ky) - margin);
  const X1 = Math.min(W, Math.ceil((m.bbox[2] + 1) / kx) + margin), Y1 = Math.min(H, Math.ceil((m.bbox[3] + 1) / ky) + margin);
  const out = cloneImg(im), o = out.d, wm = W - 1, hm = H - 1;
  for (let y = Y0; y < Y1; y++) {
    let fy = (y + 0.5) * ky - 0.5; fy = fy < 0 ? 0 : fy > fh - 1 ? fh - 1 : fy;
    const gy = fy | 0, gy1 = gy < fh - 1 ? gy + 1 : gy, ty = fy - gy;
    for (let x = X0; x < X1; x++) {
      let fx = (x + 0.5) * kx - 0.5; fx = fx < 0 ? 0 : fx > fw - 1 ? fw - 1 : fx;
      const gx = fx | 0, gx1 = gx < fw - 1 ? gx + 1 : gx, tx = fx - gx;
      const a = (gy * fw + gx) * 2, b = (gy * fw + gx1) * 2, c = (gy1 * fw + gx) * 2, e = (gy1 * fw + gx1) * 2;
      const dx = ((f[a] * (1 - tx) + f[b] * tx) * (1 - ty) + (f[c] * (1 - tx) + f[e] * tx) * ty) / 16;
      const dy = ((f[a + 1] * (1 - tx) + f[b + 1] * tx) * (1 - ty) + (f[c + 1] * (1 - tx) + f[e + 1] * tx) * ty) / 16;
      if (!dx && !dy) continue;
      let sx = x + dx / kx, sy = y + dy / ky;
      sx = sx < 0 ? 0 : sx > wm ? wm : sx; sy = sy < 0 ? 0 : sy > hm ? hm : sy;
      const ix = sx | 0, iy = sy | 0, ux = sx - ix, uy = sy - iy;
      const ix1 = ix < wm ? ix + 1 : ix, iy1 = iy < hm ? iy + 1 : iy;
      const p00 = (iy * W + ix) * 4, p10 = (iy * W + ix1) * 4, p01 = (iy1 * W + ix) * 4, p11 = (iy1 * W + ix1) * 4;
      const w00 = (1 - ux) * (1 - uy), w10 = ux * (1 - uy), w01 = (1 - ux) * uy, w11 = ux * uy;
      const q = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) o[q + k] = s[p00 + k] * w00 + s[p10 + k] * w10 + s[p01 + k] * w01 + s[p11 + k] * w11;
    }
  }
  return out;
}

// ---------------------------------------------------------------- operations
function applyOp(im, op, scale) {
  switch (op.type) {
    case "liquify": {
      const m = maps.get(op.map);
      if (!m) throw new Error("Liquify data missing - please reload the photo");
      return applyLiquify(im, m);
    }
    case "rotate": {
      const angle = +op.angle || 0;
      if (angle % 90 === 0) { const t = (((angle / 90) % 4) + 4) % 4; return t ? rotateRight(im, t) : im; }
      return rotateFree(im, angle);
    }
    case "flip": return flip(im, op.axis);
    case "crop": {
      const { w, h } = im, r = (v) => Math.round(v);   // Python round() halves to even; close enough here
      const x0 = Math.max(0, Math.min(w, r(+op.x * w))), y0 = Math.max(0, Math.min(h, r(+op.y * h)));
      const x1 = Math.max(x0 + 1, Math.min(w, r((+op.x + +op.w) * w))), y1 = Math.max(y0 + 1, Math.min(h, r((+op.y + +op.h) * h)));
      return crop(im, x0, y0, x1, y1);
    }
    case "resize": return resize(im, Math.max(1, Math.round(op.width * scale)), Math.max(1, Math.round(op.height * scale)));
    case "filter": return applyFilter(im, op.name, +(op.strength ?? 1));
  }
  throw new Error("Unknown operation: " + op.type);
}

// ---------------------------------------------------------------- adjustments
function softMask(diff, threshold) {
  const t = Math.max(threshold, 0.5), lut = new Uint8ClampedArray(256);
  for (let d = 0; d < 256; d++) lut[d] = d <= t ? 0 : d >= 2 * t ? 255 : Math.trunc(((d - t) / t) * 255);
  const m = new Uint8ClampedArray(diff.length);
  for (let i = 0; i < diff.length; i++) m[i] = lut[diff[i]];
  return m;
}
/** Image.composite(a, b, mask): a where mask is 255, b where it is 0. */
function composite(a, b, m) {
  const o = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) o[i] = b[i] + ((a[i] - b[i]) * m[i]) / 255;
  return o;
}

/** Lightroom-style noise reduction in YCbCr, same maths as editor.denoise. */
function denoise(im, adj, scale) {
  const lumAmt = (+adj.nr_lum || 0) / 100, colAmt = (+adj.nr_color || 0) / 100;
  if (lumAmt <= 0 && colAmt <= 0) return im;
  const { w, h, d } = im, n = w * h;
  let Y = new Uint8ClampedArray(n), Cb = new Uint8ClampedArray(n), Cr = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  if (lumAmt > 0) {
    const detail = (adj.nr_lum_detail ?? 50) / 100, contrast = (+adj.nr_lum_contrast || 0) / 100;
    const radius = (0.6 + 2.4 * lumAmt) * scale;
    if (radius >= 0.3) {
      const blur = blurU8(Y, w, h, radius);
      const diff = new Uint8ClampedArray(n);
      for (let i = 0; i < n; i++) diff[i] = Math.abs(Y[i] - blur[i]);
      Y = composite(Y, blur, softMask(diff, (4 + 40 * lumAmt) * (1 - 0.8 * detail)));
      if (contrast > 0) Y = unsharpPlane(Y, w, h, Math.max(1, 8 * scale), Math.trunc(80 * contrast * lumAmt), 2);
    }
  }
  if (colAmt > 0) {
    const detail = (adj.nr_color_detail ?? 50) / 100, smooth = (adj.nr_color_smooth ?? 50) / 100;
    const radius = (1 + 6 * colAmt) * (1 + 2 * smooth) * scale;
    if (radius >= 0.3) {
      const cbB = blurU8(Cb, w, h, radius), crB = blurU8(Cr, w, h, radius);
      const diff = new Uint8ClampedArray(n);
      for (let i = 0; i < n; i++) diff[i] = Math.max(Math.abs(Cb[i] - cbB[i]), Math.abs(Cr[i] - crB[i]));
      const m = softMask(diff, (3 + 30 * colAmt) * (1 - 0.8 * detail));
      Cb = composite(Cb, cbB, m); Cr = composite(Cr, crB, m);
    }
  }
  const out = cloneImg(im), o = out.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128;
    o[j] = y + 1.402 * cr; o[j + 1] = y - 0.344136 * cb - 0.714136 * cr; o[j + 2] = y + 1.772 * cb;
  }
  return out;
}

/** ImageEnhance: blend(degenerate, image, factor) = degenerate + (image - degenerate) * factor. */
function enhance(im, key, f) {
  const out = cloneImg(im), d = out.d, s = im.d;
  if (key === "brightness") {
    for (let i = 0; i < d.length; i += 4) { d[i] = s[i] * f; d[i + 1] = s[i + 1] * f; d[i + 2] = s[i + 2] * f; }
  } else if (key === "contrast") {
    let sum = 0;
    for (let i = 0; i < s.length; i += 4) sum += lum(s[i], s[i + 1], s[i + 2]);
    const m = Math.trunc(sum / (im.w * im.h) + 0.5);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = m + (s[i + c] - m) * f;
  } else if (key === "saturation") {
    for (let i = 0; i < d.length; i += 4) {
      const g = lum(s[i], s[i + 1], s[i + 2]);
      for (let c = 0; c < 3; c++) d[i + c] = g + (s[i + c] - g) * f;
    }
  } else if (key === "sharpness") {
    const g = convolve(im, 3, K_SMOOTH, 13, 0).d;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = g[i + c] + (s[i + c] - g[i + c]) * f;
  }
  return out;
}

function applyAdjustments(im, adj, scale) {
  if (!adj) return im;
  im = denoise(im, adj, scale);
  for (const key of ["brightness", "contrast", "saturation", "sharpness"]) {
    const v = adj[key] ?? 100;
    if (Math.abs(v - 100) > 0.01) im = enhance(im, key, v / 100);
  }
  const warmth = +adj.warmth || 0;
  if (Math.abs(warmth) > 0.01) {
    const k = (warmth / 100) * 0.25, out = cloneImg(im), d = out.d;
    for (let i = 0; i < d.length; i += 4) { d[i] = Math.trunc(d[i] * (1 + k)); d[i + 2] = Math.trunc(d[i + 2] * (1 - k)); }
    im = out;
  }
  return im;
}

// ---------------------------------------------------------------- render
function getPreviewBase(maxSide) {
  if (previewBase && previewBase.maxSide === maxSide) return previewBase;
  let img = full, scale = 1;
  if (maxSide && Math.max(full.w, full.h) > maxSide) {
    scale = maxSide / Math.max(full.w, full.h);
    img = resize(full, Math.max(1, Math.round(full.w * scale)), Math.max(1, Math.round(full.h * scale)));
  }
  previewBase = { img, scale, maxSide };
  return previewBase;
}

function renderGeometry(ops, maxSide) {
  const key = JSON.stringify(ops || []) + "|" + maxSide;
  if (maxSide && geoCache.has(key)) {
    const hit = geoCache.get(key);
    geoCache.delete(key); geoCache.set(key, hit);    // most recently used goes last
    return hit;
  }
  const base = maxSide ? getPreviewBase(maxSide) : { img: full, scale: 1 };
  let img = base.img;
  for (const op of ops || []) img = applyOp(img, op, base.scale);
  const res = { img, scale: base.scale };
  if (maxSide) {
    geoCache.set(key, res);
    while (geoCache.size > PREVIEW_CACHE) geoCache.delete(geoCache.keys().next().value);
  }
  return res;
}

async function encode(im, type, quality) {
  if (type === "image/jpeg" && im.alpha) {   // JPEG has no transparency: put it on white
    const c = new OffscreenCanvas(im.w, im.h), ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, im.w, im.h);
    ctx.drawImage(toCanvas(im), 0, 0);
    return c.convertToBlob({ type, quality });
  }
  return toCanvas(im).convertToBlob({ type, quality });
}

async function render({ ops, adjustments, maxSide, format, quality }) {
  if (!full) throw new Error("Image not found - please load it again");
  const { img, scale } = renderGeometry(ops, maxSide);
  const out = applyAdjustments(img, adjustments, scale);
  let type, q;
  if (format) { type = { png: "image/png", webp: "image/webp" }[format] || "image/jpeg"; q = (quality || 92) / 100; }
  else { type = out.alpha ? "image/png" : "image/jpeg"; q = 0.9; }
  const blob = await encode(out, type, q);
  return { blob, fullW: Math.round(out.w / scale), fullH: Math.round(out.h / scale), type };
}

function load(bitmap) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let alpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break; }
  full = { w: c.width, h: c.height, d, alpha };
  previewBase = null; geoCache.clear(); maps.clear();
  return { width: full.w, height: full.h };
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    let result;
    if (cmd === "load") result = load(args.bitmap);
    else if (cmd === "render") result = await render(args);
    else if (cmd === "liquify") { const mid = "m" + nextMap++; maps.set(mid, makeMap(args.w, args.h, args.buf)); result = { id: mid }; }
    else throw new Error("Unknown command " + cmd);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
