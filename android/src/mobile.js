// PhotoEditor Android glue. Loaded before app.js.
//
// The web version sends its edits to a Flask server (/api/...). On the phone
// there is no server, so this file answers those same requests locally with
// engine.js (the JavaScript port of editor.py, running in a Web Worker).
// It also adds what a phone needs: saving and sharing the result, pinch zoom
// and the Android back button.
(() => {
  const PREVIEW_MAX_SIDE = 2000;
  const LIQUIFY_MAX_SIDE = 2000;
  const cap = window.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = (name) => native && (cap.Plugins[name] || (cap.registerPlugin && cap.registerPlugin(name)));

  // ---------------------------------------------------------------- engine worker
  const worker = new Worker("engine.js");
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  };
  function call(cmd, args, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, args }, transfer);
    });
  }

  let current = { name: "photo" };

  async function decode(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      // older WebViews: an <img> applies the camera orientation when drawn
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  // ---------------------------------------------------------------- local "server"
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fail = (e) => json({ error: e.message || String(e) }, 400);

  const routes = {
    async "/api/upload"(opts) {
      const file = opts.body.get("photo");
      let bitmap;
      try { bitmap = await decode(file); } catch (_) { return json({ error: "That file is not a readable image" }, 400); }
      const info = await call("load", { bitmap }, [bitmap]);
      current = { name: file.name || "photo" };
      return json({ id: "local", name: current.name, width: info.width, height: info.height });
    },
    async "/api/render"(opts) {
      const data = JSON.parse(opts.body);
      const r = await call("render", { ops: data.ops, adjustments: data.adjustments, maxSide: PREVIEW_MAX_SIDE });
      return new Response(r.blob, { headers: { "Content-Type": r.type, "X-Full-Width": String(r.fullW), "X-Full-Height": String(r.fullH) } });
    },
    async "/api/export"(opts) {
      const data = JSON.parse(opts.body);
      const r = await exportImage(data);
      return new Response(r.blob, { headers: { "Content-Type": r.type, "Content-Disposition": `attachment; filename="${encodeURIComponent(r.filename)}"` } });
    },
    async "/api/liquify"(opts) {
      const h = opts.headers || {};
      const w = +h["X-Width"], ht = +h["X-Height"];
      if (!(w > 0 && w <= LIQUIFY_MAX_SIDE && ht > 0 && ht <= LIQUIFY_MAX_SIDE)) return json({ error: "Bad liquify size" }, 400);
      return json(await call("liquify", { w, h: ht, buf: opts.body }, [opts.body]));
    },
  };

  async function exportImage(data) {
    const fmt = (data.format || "jpeg").toLowerCase();
    const r = await call("render", { ops: data.ops, adjustments: data.adjustments, maxSide: null, format: fmt, quality: data.quality || 92 });
    const ext = fmt === "png" ? "png" : fmt === "webp" ? "webp" : "jpg";
    const base = (data.name || current.name || "photo").replace(/\.[^.]+$/, "");
    return { ...r, filename: `${base}_edited.${ext}` };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const route = typeof url === "string" && routes[url];
    if (!route) return realFetch(url, opts);
    try { return await route(opts); } catch (e) { return fail(e); }
  };

  // ---------------------------------------------------------------- saving and sharing
  const blobToBase64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });

  function notify(msg, ok = true) {
    const PE = window.PE;
    if (!PE) return;
    PE.toast(msg);
    const t = document.getElementById("toast");
    t.classList.toggle("ok", ok);
    clearTimeout(notify._t);
    notify._t = setTimeout(() => t.classList.remove("ok"), 4200);   // app.js toasts are errors (red)
  }

  async function saveToPhone(blob, filename) {
    const fs = plugin("Filesystem");
    const data = await blobToBase64(blob);
    try {
      const st = await fs.checkPermissions();
      if (st.publicStorage !== "granted") await fs.requestPermissions();   // only asked on Android 9 and older
    } catch (_) { /* newer Android needs no permission for its own files */ }
    let path = `PhotoEditor/${filename}`;
    for (let n = 2; ; n++) {   // don't overwrite an earlier save
      try { await fs.stat({ path, directory: "DOCUMENTS" }); path = `PhotoEditor/${filename.replace(/(\.\w+)$/, ` (${n})$1`)}`; }
      catch (_) { break; }
    }
    await fs.writeFile({ path, data, directory: "DOCUMENTS", recursive: true });
    notify(`Saved to Documents/${path}`);
  }

  async function share() {
    const PE = window.PE;
    if (!PE || !PE.state.id) return;
    PE.busy(true);
    try {
      const st = PE.state;
      const r = await exportImage({ ops: st.ops, adjustments: st.adj, name: st.name, format: document.getElementById("exportFormat").value });
      if (!native) { notify("Sharing works in the Android app"); return; }
      const fs = plugin("Filesystem");
      const res = await fs.writeFile({ path: r.filename, data: await blobToBase64(r.blob), directory: "CACHE" });
      await plugin("Share").share({ title: r.filename, files: [res.uri], dialogTitle: "Share photo" });
    } catch (e) {
      if (!/cancel/i.test(e.message || "")) notify("Share failed: " + e.message, false);
    } finally {
      PE.busy(false);
    }
  }

  // app.js downloads through <a download href="blob:...">, which the Android WebView ignores
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!native || !this.download || !this.href.startsWith("blob:")) return anchorClick.call(this);
    const name = this.download, href = this.href;
    window.PE && window.PE.busy(true);
    realFetch(href).then((r) => r.blob()).then((b) => saveToPhone(b, name))
      .catch((e) => notify("Saving failed: " + e.message, false))
      .finally(() => window.PE && window.PE.busy(false));
  };

  // ---------------------------------------------------------------- page tweaks
  document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const PE = window.PE;
    document.body.classList.add("mobile");

    $("downloadBtn").textContent = "Save";
    const shareBtn = document.createElement("button");
    shareBtn.id = "shareBtn"; shareBtn.className = "btn"; shareBtn.textContent = "Share"; shareBtn.disabled = true;
    $("downloadBtn").before(shareBtn);
    shareBtn.addEventListener("click", share);
    // Share follows the Save button's enabled state
    new MutationObserver(() => { shareBtn.disabled = $("downloadBtn").disabled; }).observe($("downloadBtn"), { attributes: true, attributeFilter: ["disabled"] });

    $("compareBtn").textContent = "Compare";
    $("dropHint").innerHTML = '<p><strong>Tap “Open photo”</strong></p><p class="muted">to choose a picture. JPG, PNG, WEBP, BMP, GIF</p>';
    $("compareBtn").addEventListener("contextmenu", (e) => e.preventDefault());

    // Android back button: leave crop / liquify first, otherwise put the app in the background (edits are kept)
    const app = plugin("App");
    if (app) app.addListener("backButton", () => {
      if (PE.state.mode === "crop") $("cropCancel").click();
      else if (PE.state.mode === "liquify") $("liqCancel").click();
      else app.minimizeApp();
    });

    setupPinch(PE, $("viewport"));
  });

  // ---------------------------------------------------------------- pinch zoom
  // Two fingers zoom (sent to app.js as wheel events) and pan. The first finger's
  // stroke, crop drag or pan is ended when the second finger lands.
  function setupPinch(PE, viewport) {
    const touches = new Map();
    const ignored = new Set();   // fingers left over from a pinch; ignored until lifted
    let pinch = null;
    const mid = () => { const [a, b] = [...touches.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
    const inside = (e) => viewport.contains(e.target);
    const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };

    window.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || e.pointerType !== "touch" || !inside(e)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, target: e.target });
      if (touches.size < 2) return;
      swallow(e);
      if (touches.size === 2 && PE.state.id) {
        const [firstId, first] = [...touches.entries()][0];
        first.target.dispatchEvent(new PointerEvent("pointerup", { pointerId: firstId, pointerType: "touch", bubbles: true, clientX: first.x, clientY: first.y }));
        pinch = mid();
      }
    }, true);

    window.addEventListener("pointermove", (e) => {
      if (!e.isTrusted || !touches.has(e.pointerId)) return;
      if (ignored.has(e.pointerId)) { swallow(e); return; }
      touches.get(e.pointerId).x = e.clientX;
      touches.get(e.pointerId).y = e.clientY;
      if (!pinch || touches.size !== 2) return;
      swallow(e);
      const now = mid();
      if (pinch.d > 0 && now.d > 0) {
        const ratio = now.d / pinch.d;
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -Math.log(ratio) / 0.0015, deltaMode: 0, clientX: now.x, clientY: now.y, bubbles: true, cancelable: true }));
      }
      viewport.scrollLeft -= now.x - pinch.x;
      viewport.scrollTop -= now.y - pinch.y;
      pinch = now;
    }, true);

    const lift = (e) => {
      if (!e.isTrusted || !touches.has(e.pointerId)) return;
      const wasPinch = !!pinch || ignored.has(e.pointerId);
      touches.delete(e.pointerId);
      ignored.delete(e.pointerId);
      if (wasPinch) swallow(e);
      if (pinch && touches.size < 2) { pinch = null; touches.forEach((_, id) => ignored.add(id)); }
    };
    window.addEventListener("pointerup", lift, true);
    window.addEventListener("pointercancel", lift, true);
  }
})();
