"""PhotoEditor - a small Flask web app for loading and editing photos.

Run:  python app.py   then open http://127.0.0.1:5000
"""
import io
import json
import os
import uuid
from collections import OrderedDict

from flask import Flask, jsonify, render_template, request, send_file, abort
from PIL import Image, UnidentifiedImageError

import editor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
PREVIEW_MAX_SIDE = 2000
LIQUIFY_MAX_SIDE = 2000

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB uploads
app.config["TEMPLATES_AUTO_RELOAD"] = True  # pick up index.html edits without a restart (static files already do)

_cache = {}  # image id -> loaded PIL image (keeps re-renders fast)
_maps = {}   # liquify map id -> editor.LiquifyMap
_geo_cache = OrderedDict()  # (id, ops, size) -> rendered geometry, so slider moves stay fast


def _is_hex(s):
    return bool(s) and all(c in "0123456789abcdef" for c in s)


def _load_map(map_id):
    if map_id not in _maps:
        if not _is_hex(map_id):
            raise ValueError("Invalid liquify id")
        path = os.path.join(UPLOAD_DIR, f"liq_{map_id}.bin")
        if not os.path.exists(path):
            raise ValueError("Liquify data missing - please reload the photo")
        with open(path, "rb") as f:
            w = int.from_bytes(f.read(4), "little")
            h = int.from_bytes(f.read(4), "little")
            _maps[map_id] = editor.LiquifyMap(w, h, f.read())
    return _maps[map_id]


def _resource(kind, rid):
    """Painted data that ops refer to by id (liquify maps)."""
    if kind != "liquify":
        raise ValueError(f"Unknown resource: {kind}")
    return _load_map(rid)


def _render(image_id, ops, adjustments, max_side):
    """Render with a small cache of the geometry stage (everything except sliders)."""
    img = _get_image(image_id)
    key = (image_id, json.dumps(ops or [], sort_keys=True), max_side)
    if key in _geo_cache:
        geo, scale = _geo_cache[key]
        _geo_cache.move_to_end(key)
    else:
        geo, scale = editor.render_geometry(img, ops, max_side, _resource)
        if max_side:  # only cache previews (full-size exports are one-off)
            _geo_cache[key] = (geo, scale)
            while len(_geo_cache) > 6:
                _geo_cache.popitem(last=False)
    return editor.apply_adjustments(geo, adjustments, scale), scale


def _path_for(image_id):
    if not _is_hex(image_id):
        abort(400, "Invalid image id")
    for name in os.listdir(UPLOAD_DIR):
        if name.startswith(image_id + "."):
            return os.path.join(UPLOAD_DIR, name)
    abort(404, "Image not found - please load it again")


def _get_image(image_id):
    if image_id not in _cache:
        _cache.clear()  # keep memory small: one photo at a time
        _cache[image_id] = editor.load(_path_for(image_id))
    return _cache[image_id]


@app.route("/")
def index():
    return render_template("index.html")


@app.post("/api/upload")
def upload():
    f = request.files.get("photo")
    if not f or not f.filename:
        return jsonify(error="No file received"), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        return jsonify(error=f"Unsupported file type {ext}"), 400
    image_id = uuid.uuid4().hex
    path = os.path.join(UPLOAD_DIR, image_id + ext)
    f.save(path)
    try:
        img = editor.load(path)
    except (UnidentifiedImageError, OSError):
        os.remove(path)
        return jsonify(error="That file is not a readable image"), 400
    _cache.clear()
    _geo_cache.clear()
    _cache[image_id] = img
    return jsonify(id=image_id, name=f.filename, width=img.width, height=img.height)


@app.post("/api/render")
def render_preview():
    data = request.get_json(force=True)
    try:
        out, scale = _render(data.get("id"), data.get("ops"), data.get("adjustments"), PREVIEW_MAX_SIDE)
    except (ValueError, KeyError) as e:
        return jsonify(error=str(e)), 400
    buf = io.BytesIO()
    if out.mode == "RGBA":
        out.save(buf, "PNG")
        mime = "image/png"
    else:
        out.save(buf, "JPEG", quality=90)
        mime = "image/jpeg"
    buf.seek(0)
    resp = send_file(buf, mimetype=mime)
    resp.headers["X-Full-Width"] = str(round(out.width / scale))
    resp.headers["X-Full-Height"] = str(round(out.height / scale))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/export")
def export():
    data = request.get_json(force=True)
    fmt = (data.get("format") or "jpeg").lower()
    quality = int(data.get("quality") or 92)
    try:
        out, _ = _render(data.get("id"), data.get("ops"), data.get("adjustments"), None)
    except (ValueError, KeyError) as e:
        return jsonify(error=str(e)), 400

    buf = io.BytesIO()
    if fmt == "png":
        out.save(buf, "PNG", optimize=True)
        mime, ext = "image/png", "png"
    elif fmt == "webp":
        out.save(buf, "WEBP", quality=quality)
        mime, ext = "image/webp", "webp"
    else:
        if out.mode == "RGBA":  # JPEG has no transparency: put it on white
            bg = Image.new("RGB", out.size, (255, 255, 255))
            bg.paste(out, mask=out.getchannel("A"))
            out = bg
        out.save(buf, "JPEG", quality=quality, optimize=True)
        mime, ext = "image/jpeg", "jpg"
    buf.seek(0)
    base = os.path.splitext(data.get("name") or "photo")[0]
    return send_file(buf, mimetype=mime, as_attachment=True, download_name=f"{base}_edited.{ext}")


@app.post("/api/liquify")
def upload_liquify():
    """Body: raw int16 little-endian (dx, dy) pairs; size in X-Width / X-Height headers."""
    try:
        w = int(request.headers.get("X-Width", 0))
        h = int(request.headers.get("X-Height", 0))
    except ValueError:
        return jsonify(error="Bad liquify size"), 400
    raw = request.get_data()
    if not (0 < w <= LIQUIFY_MAX_SIDE and 0 < h <= LIQUIFY_MAX_SIDE) or len(raw) != w * h * 4:
        return jsonify(error="Liquify data does not match its size"), 400
    map_id = uuid.uuid4().hex
    with open(os.path.join(UPLOAD_DIR, f"liq_{map_id}.bin"), "wb") as f:
        f.write(w.to_bytes(4, "little") + h.to_bytes(4, "little") + raw)
    _maps[map_id] = editor.LiquifyMap(w, h, raw)
    return jsonify(id=map_id)


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="File is too large (max 50 MB)"), 413


def _port_in_use(port):
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    # On Windows a second copy can bind the same port and the two then answer requests
    # at random (an old copy serves an out-of-date page), so never start a second one.
    if _port_in_use(5000):
        print("PhotoEditor is already running at http://127.0.0.1:5000")
        print("To restart it, close its window first, then run run.bat again.")
        raise SystemExit(1)
    print("PhotoEditor running - open http://127.0.0.1:5000 in your browser")
    app.run(host="127.0.0.1", port=5000, debug=False)
