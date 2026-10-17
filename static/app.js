// PhotoEditor front end. The server does the pixel work; this file keeps the
// list of edits, sends it to Flask, shows the preview and handles zoom/crop.
// liquify.js plugs into the small API exposed as window.PE at the bottom.
(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_NR = { nr_lum: 0, nr_lum_detail: 50, nr_lum_contrast: 0, nr_color: 0, nr_color_detail: 50, nr_color_smooth: 50 };
  const DEFAULT_ADJ = { brightness: 100, contrast: 100, saturation: 100, sharpness: 100, warmth: 0, ...DEFAULT_NR };
  const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.1, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
  const ZOOM_MIN = 0.02, ZOOM_MAX = 16;

  const state = {
    id: null, name: "", ops: [], redo: [], adj: { ...DEFAULT_ADJ },
    fullW: 0, fullH: 0, originalUrl: null, currentUrl: null, reqSeq: 0,
    mode: "none",            // "none" | "crop" | "liquify"
    zoom: 1, fit: true,      // zoom = screen px per full-resolution px
  };

  const preview = $("preview"), wrap = $("canvasWrap"), stage = $("stage");
  const viewport = $("viewport"), cropBox = $("cropBox"), liqCanvas = $("liqCanvas");
  const hooks = { undo: null, redo: null, zoom: [] }; // filled by liquify.js

  // ---------- helpers ----------
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), 4000);
  }
  const busy = (on) => $("spinner").classList.toggle("hidden", !on);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const isTyping = (el) => el.matches("input[type=number], input[type=text], .zval, textarea");

  /** Connect a range slider with its number box (two-way). Returns a small controller. */
  function linkSlider(row, onValue) {
    const range = row.querySelector("input[type=range]");
    const num = row.querySelector(".val");
    const clamp = (v) => Math.min(+range.max, Math.max(+range.min, v));
    const fire = () => onValue && onValue(+range.value);
    range.addEventListener("input", () => { num.value = range.value; fire(); });
    num.addEventListener("input", () => {           // live while typing
      if (num.value === "" || isNaN(+num.value)) return;
      range.value = clamp(+num.value);
      fire();
    });
    num.addEventListener("change", () => {          // on Enter / leaving the box: tidy up
      const v = num.value === "" || isNaN(+num.value) ? +range.value : clamp(+num.value);
      range.value = v;
      num.value = range.value;
      fire();
    });
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") num.blur();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.stopPropagation();
    });
    return {
      range, num,
      get: () => +range.value,
      set(v) { range.value = v; num.value = range.value; },
    };
  }

  function opLabel(op) {
    switch (op.type) {
      case "rotate": return op.angle === 90 ? "Rotate left" : op.angle === 270 ? "Rotate right"
        : op.angle === 180 ? "Rotate 180°" : `Straighten ${-op.angle}°`;
      case "flip": return op.axis === "h" ? "Flip horizontal" : "Flip vertical";
      case "crop": return "Crop";
      case "resize": return `Resize to ${op.width}×${op.height}`;
      case "filter": return "Filter: " + op.name;
      case "liquify": return "Liquify";
    }
    return op.type;
  }

  function setEnabled(on) {
    $("panel").querySelectorAll("button, input, select").forEach((el) => {
      if (el.closest("#cropActions")) return;
      el.disabled = !on;
    });
    ["compareBtn", "resetBtn", "exportFormat", "downloadBtn"].forEach((id) => { $(id).disabled = !on; });
    if (on) refreshButtons();
  }

  function refreshButtons() {
    if (state.mode === "liquify") return;
    $("undoBtn").disabled = !state.ops.length;
    $("redoBtn").disabled = !state.redo.length;
    const hist = $("history");
    hist.innerHTML = "";
    if (!state.ops.length && !state.redo.length) hist.innerHTML = '<li class="muted">No edits yet</li>';
    state.ops.forEach((op) => { const li = document.createElement("li"); li.textContent = opLabel(op); hist.appendChild(li); });
    [...state.redo].reverse().forEach((op) => { const li = document.createElement("li"); li.className = "future"; li.textContent = opLabel(op); hist.appendChild(li); });
    hist.scrollTop = hist.scrollHeight;
  }

  function updateSizeFields() {
    $("resizeW").value = state.fullW;
    $("resizeH").value = state.fullH;
    $("status").textContent = `${state.fullW} × ${state.fullH} px`;
  }

  // ---------- server calls ----------
  async function render(extraOps = []) {
    if (!state.id) return;
    const seq = ++state.reqSeq;
    busy(true);
    try {
      const res = await fetch("/api/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.id, ops: [...state.ops, ...extraOps], adjustments: state.adj }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      if (seq !== state.reqSeq) return; // a newer render is on its way
      const url = URL.createObjectURL(blob);
      await new Promise((ok) => { preview.onload = ok; preview.onerror = ok; preview.src = url; });
      if (state.currentUrl && state.currentUrl !== state.originalUrl) URL.revokeObjectURL(state.currentUrl);
      state.currentUrl = url;
      const w = +res.headers.get("X-Full-Width"), h = +res.headers.get("X-Full-Height");
      const sizeChanged = w !== state.fullW || h !== state.fullH;
      state.fullW = w; state.fullH = h;
      updateSizeFields();
      if (state.fit) fitZoom(); else if (sizeChanged) applyZoom(); else applyZoom();
    } catch (e) {
      toast("Could not update preview: " + e.message);
    } finally {
      if (seq === state.reqSeq) busy(false);
    }
  }
  const renderSoon = debounce(render, 120);

  async function loadFile(file) {
    if (!file) return;
    if (state.mode === "liquify") { toast("Apply or cancel Liquify first"); return; }
    if (!file.type.startsWith("image/") && !/\.(tiff?|bmp|webp)$/i.test(file.name)) {
      toast("Please choose an image file"); return;
    }
    const fd = new FormData();
    fd.append("photo", file);
    busy(true);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      Object.assign(state, { id: data.id, name: data.name, ops: [], redo: [], adj: { ...DEFAULT_ADJ }, fit: true, fullW: 0, fullH: 0 });
      endCrop();
      syncSliders();
      $("fileName").textContent = `${data.name} (${data.width} × ${data.height})`;
      $("dropHint").classList.add("hidden");
      wrap.classList.remove("hidden");
      $("zoombar").classList.remove("hidden");
      setEnabled(true);
      await render();
      state.originalUrl = state.currentUrl;
    } catch (e) {
      toast("Could not open photo: " + e.message);
    } finally {
      busy(false);
    }
  }

  async function download() {
    busy(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.id, name: state.name, ops: state.ops, adjustments: state.adj, format: $("exportFormat").value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = m ? decodeURIComponent(m[1]) : "photo_edited";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      toast("Download failed: " + e.message);
    } finally {
      busy(false);
    }
  }

  // ---------- edit actions ----------
  function pushOp(op) {
    state.ops.push(op);
    state.redo = [];
    refreshButtons();
    return render();
  }
  function undo() {
    if (state.mode === "liquify") return hooks.undo && hooks.undo();
    if (!state.ops.length) return;
    state.redo.push(state.ops.pop()); refreshButtons(); render();
  }
  function redo() {
    if (state.mode === "liquify") return hooks.redo && hooks.redo();
    if (!state.redo.length) return;
    state.ops.push(state.redo.pop()); refreshButtons(); render();
  }
  function resetAll() {
    state.ops = []; state.redo = []; state.adj = { ...DEFAULT_ADJ };
    syncSliders(); straighten.set(0); endCrop(); refreshButtons(); render();
  }

  document.querySelectorAll("[data-op]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.op === "rotate") pushOp({ type: "rotate", angle: +b.dataset.angle });
    else pushOp({ type: "flip", axis: b.dataset.axis });
  }));
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => pushOp({ type: "filter", name: b.dataset.filter })));

  // straighten (free rotation) with live preview
  const straighten = linkSlider($("straightenRow"), (v) => renderSoon(v ? [{ type: "rotate", angle: -v }] : []));
  $("straightenApply").addEventListener("click", () => {
    const v = straighten.get();
    straighten.set(0);
    if (v) pushOp({ type: "rotate", angle: -v }); else render();
  });

  // resize
  $("resizeW").addEventListener("input", () => {
    if ($("resizeLock").checked && state.fullW) $("resizeH").value = Math.max(1, Math.round($("resizeW").value * state.fullH / state.fullW));
  });
  $("resizeH").addEventListener("input", () => {
    if ($("resizeLock").checked && state.fullH) $("resizeW").value = Math.max(1, Math.round($("resizeH").value * state.fullW / state.fullH));
  });
  $("resizeApply").addEventListener("click", () => {
    const w = parseInt($("resizeW").value, 10), h = parseInt($("resizeH").value, 10);
    if (!(w > 0 && h > 0)) { toast("Enter a valid width and height"); return; }
    if (w > 20000 || h > 20000) { toast("Maximum size is 20000 px"); return; }
    if (w === state.fullW && h === state.fullH) return;
    pushOp({ type: "resize", width: w, height: h });
  });

  // adjustment sliders (slider + number box)
  const adjCtl = {};
  document.querySelectorAll(".slider.adj").forEach((row) => {
    const key = row.dataset.key;
    adjCtl[key] = linkSlider(row, (v) => { state.adj[key] = v; showSubSliders(); renderSoon(); });
    adjCtl[key].range.addEventListener("dblclick", () => { state.adj[key] = DEFAULT_ADJ[key]; adjCtl[key].set(DEFAULT_ADJ[key]); showSubSliders(); render(); });
  });
  function syncSliders() { Object.keys(adjCtl).forEach((k) => adjCtl[k].set(state.adj[k])); showSubSliders(); }
  // noise reduction Detail/Contrast/Smoothness only matter (and only show) once their amount is above 0
  function showSubSliders() {
    document.querySelectorAll(".slider.sub[data-parent]").forEach((row) => row.classList.toggle("off", !(state.adj[row.dataset.parent] > 0)));
  }
  // each reset link only resets its own section
  $("adjReset").addEventListener("click", () => { state.adj = { ...DEFAULT_ADJ, ...pick(state.adj, DEFAULT_NR) }; syncSliders(); render(); });
  $("nrReset").addEventListener("click", () => { Object.assign(state.adj, DEFAULT_NR); syncSliders(); render(); });
  function pick(obj, keysOf) { return Object.fromEntries(Object.keys(keysOf).map((k) => [k, obj[k]])); }

  // compare with original
  const showOriginal = (on) => { if (state.originalUrl && state.mode !== "liquify") preview.src = on ? state.originalUrl : state.currentUrl; };
  $("compareBtn").addEventListener("pointerdown", () => showOriginal(true));
  ["pointerup", "pointerleave"].forEach((ev) => $("compareBtn").addEventListener(ev, () => showOriginal(false)));

  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("resetBtn").addEventListener("click", resetAll);
  $("downloadBtn").addEventListener("click", download);
  $("fileInput").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });

  // drag & drop
  ["dragenter", "dragover"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("dragover"); }));
  stage.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // ================================================================ zoom & pan
  function displaySize() { return { w: state.fullW * state.zoom, h: state.fullH * state.zoom }; }

  function applyZoom() {
    if (!state.fullW) return;
    const { w, h } = displaySize();
    for (const el of [preview, liqCanvas]) { el.style.width = w + "px"; el.style.height = h + "px"; }
    // show crisp pixels when zoomed in past the preview's own resolution
    const srcW = state.mode === "liquify" ? liqCanvas.width : preview.naturalWidth || state.fullW;
    wrap.classList.toggle("pixelated", w / srcW > 2);
    $("zoomVal").value = Math.round(state.zoom * 1000) / 10 + "%";
    updatePanCursor();
    hooks.zoom.forEach((fn) => fn());
  }

  function fitScale() {
    const vw = viewport.clientWidth - 48, vh = viewport.clientHeight - 48;
    if (!state.fullW || vw <= 0 || vh <= 0) return 1;
    return Math.min(vw / state.fullW, vh / state.fullH, 1);
  }

  function setZoom(z, anchor) {
    if (!state.fullW) return;
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const before = wrap.getBoundingClientRect();
    const ax = anchor ? anchor.clientX : before.left + before.width / 2;
    const ay = anchor ? anchor.clientY : before.top + before.height / 2;
    // keep the anchor point (or the image centre) under the same screen spot
    let vpRect = viewport.getBoundingClientRect();
    const refX = anchor ? ax : vpRect.left + vpRect.width / 2;
    const refY = anchor ? ay : vpRect.top + vpRect.height / 2;
    const fx = (refX - before.left) / before.width, fy = (refY - before.top) / before.height;
    const oldW = before.width;

    state.zoom = z;
    applyZoom();
    if (state.mode === "crop" && box) {
      const k = displaySize().w / oldW;
      box = { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k };
      drawBox();
    }
    const after = wrap.getBoundingClientRect();
    viewport.scrollLeft += after.left + fx * after.width - refX;
    viewport.scrollTop += after.top + fy * after.height - refY;
  }

  function fitZoom() { state.fit = true; setZoom(fitScale()); }
  function zoomBy(dir, anchor) {
    state.fit = false;
    const z = state.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001);
    setZoom(next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN), anchor);
  }

  $("zoomIn").addEventListener("click", () => zoomBy(1));
  $("zoomOut").addEventListener("click", () => zoomBy(-1));
  $("zoomFit").addEventListener("click", fitZoom);
  $("zoom100").addEventListener("click", () => { state.fit = false; setZoom(1); });
  $("zoomVal").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = parseFloat(e.target.value);
    if (v > 0) { state.fit = false; setZoom(v / 100); }
    e.target.blur();
  });
  $("zoomVal").addEventListener("blur", applyZoom);

  viewport.addEventListener("wheel", (e) => {
    if (!state.fullW) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    state.fit = false;
    setZoom(state.zoom * Math.exp(-dy * 0.0015), e);
  }, { passive: false });

  // panning: drag with middle button, with Space held, or with the left button when no tool is active
  let spaceDown = false, pan = null;
  function canPan() { return viewport.scrollWidth > viewport.clientWidth + 1 || viewport.scrollHeight > viewport.clientHeight + 1; }
  function updatePanCursor() { viewport.classList.toggle("pan", !!state.id && canPan() && (state.mode === "none" || spaceDown)); }
  viewport.addEventListener("pointerdown", (e) => {
    if (!state.id) return;
    const want = e.button === 1 || (e.button === 0 && (spaceDown || (state.mode === "none" && canPan())));
    if (!want) return;
    e.preventDefault(); e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop, id: e.pointerId };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
  }, true);
  viewport.addEventListener("pointermove", (e) => {
    if (!pan) return;
    viewport.scrollLeft = pan.sl - (e.clientX - pan.x);
    viewport.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = () => { if (pan) { pan = null; viewport.classList.remove("panning"); } };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  window.addEventListener("resize", () => { if (state.fit) fitZoom(); else updatePanCursor(); });

  // ================================================================ keyboard
  document.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    if (e.code === "Space" && state.id) { spaceDown = true; updatePanCursor(); if (e.target === document.body) e.preventDefault(); }
    if (!state.id) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && (k === "+" || k === "=")) { e.preventDefault(); zoomBy(1); }
    else if (mod && k === "-") { e.preventDefault(); zoomBy(-1); }
    else if (mod && k === "0") { e.preventDefault(); fitZoom(); }
    else if (mod && k === "1") { e.preventDefault(); state.fit = false; setZoom(1); }
    else if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (k === "enter" && state.mode === "crop") applyCrop();
    else if (k === "escape" && state.mode === "crop") endCrop();
  });
  document.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; updatePanCursor(); } });

  // ================================================================ crop tool
  let box = null;   // {x, y, w, h} in displayed pixels
  let drag = null;

  const ratio = () => ($("cropRatio").value === "free" ? null : +$("cropRatio").value);
  const dims = () => ({ W: preview.clientWidth, H: preview.clientHeight });

  function drawBox() {
    if (!box) { cropBox.classList.add("hidden"); return; }
    Object.assign(cropBox.style, { left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" });
    cropBox.classList.remove("hidden");
  }

  function defaultBox() {
    const { W, H } = dims();
    let w = W * 0.8, h = H * 0.8;
    const r = ratio();
    if (r) { if (w / h > r) w = h * r; else h = w / r; }
    box = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function startCrop() {
    state.mode = "crop";
    wrap.classList.add("cropping");
    $("cropActions").classList.remove("hidden");
    $("cropBtn").disabled = true;
    defaultBox(); drawBox(); updatePanCursor();
  }
  function endCrop() {
    if (state.mode === "crop") state.mode = "none";
    box = null; drag = null;
    wrap.classList.remove("cropping");
    $("cropActions").classList.add("hidden");
    if (state.id) $("cropBtn").disabled = false;
    drawBox(); updatePanCursor();
  }
  function applyCrop() {
    if (!box) return;
    const { W, H } = dims();
    const op = { type: "crop", x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H };
    endCrop();
    if (op.w > 0.001 && op.h > 0.001) pushOp(op);
  }

  $("cropBtn").addEventListener("click", startCrop);
  $("cropApply").addEventListener("click", applyCrop);
  $("cropCancel").addEventListener("click", endCrop);
  $("cropRatio").addEventListener("change", () => { if (state.mode === "crop") { defaultBox(); drawBox(); } });

  function localPoint(e) {
    const r = preview.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  }

  wrap.addEventListener("pointerdown", (e) => {
    if (state.mode !== "crop" || e.button !== 0) return;
    e.preventDefault();
    const p = localPoint(e);
    let mode = "new";
    if (e.target.classList.contains("h")) mode = [...e.target.classList].find((c) => c.length === 2);
    else if (e.target === cropBox) mode = "move";
    drag = { mode, sx: p.x, sy: p.y, start: box ? { ...box } : null };
    wrap.setPointerCapture(e.pointerId);
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = localPoint(e);
    const { W, H } = dims();
    const r = ratio();
    if (drag.mode === "move") {
      const s = drag.start;
      box = { ...s, x: Math.min(Math.max(s.x + p.x - drag.sx, 0), W - s.w), y: Math.min(Math.max(s.y + p.y - drag.sy, 0), H - s.h) };
    } else {
      let ax, ay;
      if (drag.mode === "new") { ax = drag.sx; ay = drag.sy; }
      else {
        const s = drag.start;
        ax = drag.mode.includes("w") ? s.x + s.w : s.x;
        ay = drag.mode.includes("n") ? s.y + s.h : s.y;
      }
      let w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
      const dirX = p.x < ax ? -1 : 1, dirY = p.y < ay ? -1 : 1;
      if (r) {
        if (w / Math.max(h, 1) > r) h = w / r; else w = h * r;
        const maxW = dirX < 0 ? ax : W - ax, maxH = dirY < 0 ? ay : H - ay;
        if (w > maxW) { w = maxW; h = w / r; }
        if (h > maxH) { h = maxH; w = h * r; }
      }
      box = { x: dirX < 0 ? ax - w : ax, y: dirY < 0 ? ay - h : ay, w, h };
    }
    drawBox();
  });

  wrap.addEventListener("pointerup", () => {
    if (drag && box && (box.w < 8 || box.h < 8)) { defaultBox(); drawBox(); }
    drag = null;
  });

  setEnabled(false);

  // ================================================================ API for liquify.js
  window.PE = {
    state, hooks, toast, busy, render, pushOp, linkSlider, applyZoom, fitZoom, setEnabled, refreshButtons, updatePanCursor,
    endCrop, preview, liqCanvas, wrap, viewport,
  };
})();
