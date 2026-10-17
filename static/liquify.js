// Liquify (Photoshop-style) for PhotoEditor.
//
// How it works: we keep a displacement field D (dx, dy per pixel). Each output
// pixel p shows the source pixel at p + D(p). Brushes edit D, the canvas is
// redrawn only where the brush touched. "Apply" sends D to the server, which
// applies the same warp to the full-resolution photo.
(() => {
  const PE = window.PE;
  const $ = (id) => document.getElementById(id);
  const MAX_FIELD_SIDE = 1000;   // working resolution of the liquify canvas
  const MAX_UNDO = 12;

  const canvas = PE.liqCanvas, ctx = canvas.getContext("2d", { willReadFrequently: true });
  const brushEl = $("brush");

  let W = 0, H = 0;              // field / canvas size
  let src = null;                // Uint8ClampedArray of the photo at W×H
  let out = null;                // ImageData written to the canvas
  let DX = null, DY = null;      // displacement in field pixels
  let undoStack = [], redoStack = [];
  let tool = "warp";
  let stroke = null;             // active stroke state

  // ---------- options (slider + number box) ----------
  const opt = {};
  document.querySelectorAll(".slider.liq").forEach((row) => {
    opt[row.dataset.key] = PE.linkSlider(row, () => updateBrush());
  });
  const sizeImgPx = () => opt.size.get();                         // brush diameter in photo pixels
  const radiusField = () => Math.max(1, (sizeImgPx() / 2) * (W / PE.state.fullW));

  // ---------- tool buttons ----------
  function setTool(t) {
    tool = t;
    document.querySelectorAll("#liqTools [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  }
  document.querySelectorAll("#liqTools [data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

  // ---------- enter / leave ----------
  async function open() {
    const st = PE.state;
    if (!st.id || st.mode === "liquify") return;
    PE.endCrop();
    const img = PE.preview;
    const k = Math.min(1, MAX_FIELD_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    W = Math.max(1, Math.round(img.naturalWidth * k));
    H = Math.max(1, Math.round(img.naturalHeight * k));
    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    src = ctx.getImageData(0, 0, W, H).data.slice();
    out = ctx.getImageData(0, 0, W, H);
    DX = new Float32Array(W * H);
    DY = new Float32Array(W * H);
    undoStack = []; redoStack = [];

    st.mode = "liquify";
    $("panel").classList.add("hidden");
    $("liqPanel").classList.remove("hidden");
    img.classList.add("hidden");
    canvas.classList.remove("hidden");
    ["compareBtn", "resetBtn", "exportFormat", "downloadBtn"].forEach((id) => { $(id).disabled = true; });
    $("openBtn").classList.add("hidden");
    refreshUndo();
    PE.applyZoom();
    PE.updatePanCursor();
  }

  function close() {
    const st = PE.state;
    st.mode = "none";
    stroke = null;
    brushEl.classList.add("hidden");
    canvas.classList.add("hidden");
    PE.preview.classList.remove("hidden");
    $("liqPanel").classList.add("hidden");
    $("panel").classList.remove("hidden");
    $("openBtn").classList.remove("hidden");
    DX = DY = src = out = null;
    undoStack = []; redoStack = [];
    PE.setEnabled(true);
    PE.applyZoom();
  }

  async function apply() {
    if (!DX) return;
    let any = false;
    for (let i = 0; i < DX.length; i++) if (DX[i] || DY[i]) { any = true; break; }
    if (!any) { close(); return; }
    // int16 interleaved (dx, dy) in 1/16 pixel
    const buf = new Int16Array(W * H * 2);
    for (let i = 0; i < W * H; i++) {
      buf[2 * i] = Math.max(-32767, Math.min(32767, Math.round(DX[i] * 16)));
      buf[2 * i + 1] = Math.max(-32767, Math.min(32767, Math.round(DY[i] * 16)));
    }
    PE.busy(true);
    try {
      const res = await fetch("/api/liquify", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Width": W, "X-Height": H },
        body: buf.buffer,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      close();
      await PE.pushOp({ type: "liquify", map: data.id });
    } catch (e) {
      PE.toast("Liquify failed: " + e.message);
    } finally {
      PE.busy(false);
    }
  }

  $("liqOpen").addEventListener("click", open);
  $("liqCancel").addEventListener("click", close);
  $("liqApply").addEventListener("click", apply);

  // ---------- undo ----------
  function snapshot() { return { dx: DX.slice(), dy: DY.slice() }; }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    refreshUndo();
  }
  function restore(s) { DX.set(s.dx); DY.set(s.dy); redraw(0, 0, W, H); }
  function liqUndo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); refreshUndo(); }
  function liqRedo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); refreshUndo(); }
  function refreshUndo() {
    $("liqUndo").disabled = !undoStack.length;
    $("liqRedo").disabled = !redoStack.length;
    $("undoBtn").disabled = !undoStack.length;
    $("redoBtn").disabled = !redoStack.length;
  }
  $("liqUndo").addEventListener("click", liqUndo);
  $("liqRedo").addEventListener("click", liqRedo);
  $("liqRestore").addEventListener("click", () => { pushUndo(); DX.fill(0); DY.fill(0); redraw(0, 0, W, H); });
  PE.hooks.undo = liqUndo;
  PE.hooks.redo = liqRedo;

  // ---------- drawing ----------
  function redraw(x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;
    const o = out.data, s = src, wm = W - 1, hm = H - 1;
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0;
      for (let x = x0; x < x1; x++, i++) {
        let sx = x + DX[i], sy = y + DY[i];
        if (sx < 0) sx = 0; else if (sx > wm) sx = wm;
        if (sy < 0) sy = 0; else if (sy > hm) sy = hm;
        const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
        const ix1 = ix < wm ? ix + 1 : ix, iy1 = iy < hm ? iy + 1 : iy;
        const a = (iy * W + ix) * 4, b = (iy * W + ix1) * 4, c = (iy1 * W + ix) * 4, d = (iy1 * W + ix1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const oi = i * 4;
        o[oi] = s[a] * w00 + s[b] * w10 + s[c] * w01 + s[d] * w11;
        o[oi + 1] = s[a + 1] * w00 + s[b + 1] * w10 + s[c + 1] * w01 + s[d + 1] * w11;
        o[oi + 2] = s[a + 2] * w00 + s[b + 2] * w10 + s[c + 2] * w01 + s[d + 2] * w11;
        o[oi + 3] = s[a + 3] * w00 + s[b + 3] * w10 + s[c + 3] * w01 + s[d + 3] * w11;
      }
    }
    ctx.putImageData(out, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  // ---------- brush maths ----------
  // copy of D around the dab, so every pixel reads the field as it was before this dab
  let old = { x0: 0, y0: 0, w: 0, h: 0, dx: new Float32Array(0), dy: new Float32Array(0) };
  function copyOld(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    if (old.dx.length < w * h) { old.dx = new Float32Array(w * h); old.dy = new Float32Array(w * h); }
    for (let y = 0; y < h; y++) {
      const srcI = (y0 + y) * W + x0;
      old.dx.set(DX.subarray(srcI, srcI + w), y * w);
      old.dy.set(DY.subarray(srcI, srcI + w), y * w);
    }
    Object.assign(old, { x0, y0, w, h });
  }
  // bilinear read of the old field at (fx, fy); outside the copied box falls back to the live field
  function oldAt(fx, fy, res) {
    fx = Math.min(Math.max(fx, 0), W - 1); fy = Math.min(Math.max(fy, 0), H - 1);
    let lx = fx - old.x0, ly = fy - old.y0;
    let ax, ay, w, bx, by;
    if (lx >= 0 && ly >= 0 && lx <= old.w - 1 && ly <= old.h - 1) { ax = old.dx; ay = old.dy; w = old.w; bx = lx; by = ly; }
    else { ax = DX; ay = DY; w = W; bx = fx; by = fy; }
    const maxX = (ax === DX ? W : old.w) - 1, maxY = (ax === DX ? H : old.h) - 1;
    const x0 = bx | 0, y0 = by | 0, x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
    const tx = bx - x0, ty = by - y0;
    const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
    res[0] = (ax[i00] * (1 - tx) + ax[i10] * tx) * (1 - ty) + (ax[i01] * (1 - tx) + ax[i11] * tx) * ty;
    res[1] = (ay[i00] * (1 - tx) + ay[i10] * tx) * (1 - ty) + (ay[i01] * (1 - tx) + ay[i11] * tx) * ty;
  }

  const tmp = [0, 0], acc = [0, 0];
  /** One brush dab at field coords (cx, cy). (vx, vy) is the movement for Forward Warp. */
  function dab(cx, cy, vx = 0, vy = 0) {
    const r = radiusField();
    const pressure = opt.pressure.get() / 100;
    const rate = opt.rate.get() / 100;
    const expo = 0.5 + 2.5 * (1 - opt.density.get() / 100);   // density: higher = harder edge
    const reach = r * 1.15 + Math.hypot(vx, vy) + 3;
    copyOld(cx - reach, cy - reach, cx + reach + 1, cy + reach + 1);

    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ex = x - cx, ey = y - cy, d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        const wgt = Math.pow(1 - d2 / r2, expo);
        const a = wgt * pressure;
        const i = y * W + x;
        let qx, qy;
        switch (tool) {
          case "warp": qx = x - a * vx; qy = y - a * vy; break;
          case "pucker": { const s = a * rate * 0.08; qx = cx + ex * (1 + s); qy = cy + ey * (1 + s); break; }
          case "bloat": { const s = a * rate * 0.08; qx = cx + ex * (1 - s); qy = cy + ey * (1 - s); break; }
          case "twirlcw":
          case "twirlccw": {
            const th = (tool === "twirlcw" ? -1 : 1) * a * rate * 0.12;
            const cs = Math.cos(th), sn = Math.sin(th);
            qx = cx + ex * cs - ey * sn; qy = cy + ex * sn + ey * cs; break;
          }
          case "reconstruct": {
            oldAt(x, y, tmp);
            const k = Math.min(1, a * rate * 0.2);
            DX[i] = tmp[0] * (1 - k); DY[i] = tmp[1] * (1 - k);
            continue;
          }
          case "smooth": {
            oldAt(x, y, tmp);
            let sx = 0, sy = 0, n = 0;
            const st = Math.max(1, r * 0.15);
            for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
              oldAt(x + ox * st, y + oy * st, acc); sx += acc[0]; sy += acc[1]; n++;
            }
            const k = Math.min(1, a * rate * 0.6);
            DX[i] = tmp[0] + (sx / n - tmp[0]) * k; DY[i] = tmp[1] + (sy / n - tmp[1]) * k;
            continue;
          }
        }
        oldAt(qx, qy, tmp);
        DX[i] = qx - x + tmp[0];
        DY[i] = qy - y + tmp[1];
      }
    }
    return [x0, y0, x1 + 1, y1 + 1];
  }

  // ---------- pointer handling ----------
  function toField(e) {
    const rc = canvas.getBoundingClientRect();
    return { x: (e.clientX - rc.left) / rc.width * W, y: (e.clientY - rc.top) / rc.height * H };
  }

  function updateBrush(e) {
    if (PE.state.mode !== "liquify") return;
    const d = sizeImgPx() * PE.state.zoom;
    brushEl.style.width = brushEl.style.height = d + "px";
    if (e) {
      const rc = PE.wrap.getBoundingClientRect();
      brushEl.style.left = e.clientX - rc.left + "px";
      brushEl.style.top = e.clientY - rc.top + "px";
    }
  }
  PE.hooks.zoom.push(() => updateBrush());

  canvas.addEventListener("pointerenter", () => { if (PE.state.mode === "liquify") brushEl.classList.remove("hidden"); });
  canvas.addEventListener("pointerleave", () => { if (!stroke) brushEl.classList.add("hidden"); });

  canvas.addEventListener("pointerdown", (e) => {
    if (PE.state.mode !== "liquify" || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    const p = toField(e);
    stroke = { raw: p, pos: { ...p }, last: { ...p } };
    if (tool !== "warp") { const b = dab(p.x, p.y); redraw(...b); }
    requestAnimationFrame(tick);
  });
  canvas.addEventListener("pointermove", (e) => {
    updateBrush(e);
    if (stroke) stroke.raw = toField(e);
  });
  const endStroke = () => { stroke = null; };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  function tick() {
    if (!stroke || PE.state.mode !== "liquify") return;
    const s = stroke;
    const follow = 1 - (opt.smoothing.get() / 100) * 0.9;     // stroke smoothing = lazy cursor
    s.pos.x += (s.raw.x - s.pos.x) * follow;
    s.pos.y += (s.raw.y - s.pos.y) * follow;

    const r = radiusField();
    const mx = s.pos.x - s.last.x, my = s.pos.y - s.last.y;
    const dist = Math.hypot(mx, my);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const grow = (b) => { bx0 = Math.min(bx0, b[0]); by0 = Math.min(by0, b[1]); bx1 = Math.max(bx1, b[2]); by1 = Math.max(by1, b[3]); };

    if (tool === "warp") {
      if (dist > 0.3) {
        const steps = Math.max(1, Math.ceil(dist / (r * 0.2)));
        for (let k = 1; k <= steps; k++) {
          const px = s.last.x + mx * k / steps, py = s.last.y + my * k / steps;
          grow(dab(px, py, mx / steps, my / steps));
        }
        s.last = { ...s.pos };
      }
    } else {
      // stationary tools keep working while the mouse is held down
      const steps = Math.max(1, Math.ceil(dist / (r * 0.35)));
      for (let k = 1; k <= steps; k++) grow(dab(s.last.x + mx * k / steps, s.last.y + my * k / steps));
      s.last = { ...s.pos };
    }
    if (bx1 > bx0) redraw(bx0, by0, bx1, by1);
    requestAnimationFrame(tick);
  }

  // ---------- keyboard ----------
  const KEYS = { w: "warp", r: "reconstruct", e: "smooth", c: "twirlcw", s: "pucker", b: "bloat" };
  document.addEventListener("keydown", (e) => {
    if (PE.state.mode !== "liquify" || e.target.matches("input[type=number], input[type=text], .zval")) return;
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "[" || k === "]") {
      const v = opt.size.get();
      const step = Math.max(2, Math.round(v * 0.1));
      opt.size.set(k === "[" ? v - step : v + step);
      updateBrush();
    } else if (k === "c" && e.altKey) { e.preventDefault(); setTool("twirlccw"); }
    else if (KEYS[k]) setTool(KEYS[k]);
    else if (k === "enter") apply();
    else if (k === "escape") close();
  });
})();
