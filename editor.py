"""Image editing pipeline built on Pillow.

The browser keeps a list of operations (rotate, crop, filter...) plus a set of
slider adjustments. The server always re-applies that list to the original
photo, so undo/redo is just removing or re-adding an operation.
"""
import math
from array import array

from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps

FILTERS = {
    "grayscale", "sepia", "invert", "blur", "sharpen", "edge", "emboss",
    "contour", "smooth", "autocontrast", "equalize", "posterize", "vignette",
}


def load(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)  # respect camera orientation
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or img.mode == "P" else "RGB")
    return img


def _rgb(img):
    """Return (rgb_image, alpha_or_None) so filters work on RGBA too."""
    if img.mode == "RGBA":
        return img.convert("RGB"), img.getchannel("A")
    return img, None


def _merge(rgb, alpha):
    if alpha is not None:
        if alpha.size != rgb.size:
            alpha = alpha.resize(rgb.size)
        rgb = rgb.copy()
        rgb.putalpha(alpha)
    return rgb


def apply_filter(img, name, strength=1.0):
    rgb, alpha = _rgb(img)
    if name == "grayscale":
        out = ImageOps.grayscale(rgb).convert("RGB")
    elif name == "sepia":
        g = ImageOps.grayscale(rgb)
        out = ImageOps.colorize(g, black="#2b1d0e", white="#fff4e0", mid="#a67c52")
    elif name == "invert":
        out = ImageOps.invert(rgb)
    elif name == "blur":
        out = rgb.filter(ImageFilter.GaussianBlur(radius=max(0.5, 3 * strength)))
    elif name == "sharpen":
        out = rgb.filter(ImageFilter.UnsharpMask(radius=2, percent=int(150 * strength), threshold=3))
    elif name == "edge":
        out = rgb.filter(ImageFilter.FIND_EDGES)
    elif name == "emboss":
        out = rgb.filter(ImageFilter.EMBOSS)
    elif name == "contour":
        out = rgb.filter(ImageFilter.CONTOUR)
    elif name == "smooth":
        out = rgb.filter(ImageFilter.SMOOTH_MORE)
    elif name == "autocontrast":
        out = ImageOps.autocontrast(rgb, cutoff=1)
    elif name == "equalize":
        out = ImageOps.equalize(rgb)
    elif name == "posterize":
        out = ImageOps.posterize(rgb, 3)
    elif name == "vignette":
        # radial gradient: 0 in the centre, 255 at the edge -> keep centre bright
        grad = Image.radial_gradient("L").resize(rgb.size, Image.BILINEAR)
        mask = grad.point(lambda p: 255 if p < 90 else max(0, 255 - int((p - 90) * 1.6)))
        dark = ImageEnhance.Brightness(rgb).enhance(0.15)
        out = Image.composite(rgb, dark, mask)
    else:
        raise ValueError(f"Unknown filter: {name}")
    return _merge(out, alpha)


# ---------------------------------------------------------------- liquify
class LiquifyMap:
    """Displacement field painted in the browser.

    For every output pixel p the field says where to sample the source:
    src = p + D(p). Values arrive as int16 in 1/16 of a field pixel, stored
    interleaved (dx, dy). Because it is resolution independent (scaled by
    field size -> image size) it works for the preview and full-size export.
    """

    def __init__(self, width, height, raw):
        self.w, self.h = width, height
        self.data = array("h")
        self.data.frombytes(raw)
        if len(self.data) != width * height * 2:
            raise ValueError("Liquify map has the wrong size")
        # bounding box of non-zero displacement (field pixels) -> only that area is warped
        xs0, ys0, xs1, ys1 = width, height, -1, -1
        d = self.data
        for y in range(height):
            row = y * width * 2
            seg = d[row:row + width * 2]
            if not any(seg):
                continue
            first = next(i for i, v in enumerate(seg) if v) // 2
            last = (len(seg) - 1 - next(i for i, v in enumerate(reversed(seg)) if v)) // 2
            xs0, xs1 = min(xs0, first), max(xs1, last)
            ys0, ys1 = min(ys0, y), max(ys1, y)
        self.bbox = None if xs1 < 0 else (xs0, ys0, xs1, ys1)

    def sample(self, fx, fy):
        """Bilinear sample at field coords; returns (dx, dy) in field pixels."""
        w, h, d = self.w, self.h, self.data
        fx = min(max(fx, 0.0), w - 1.0)
        fy = min(max(fy, 0.0), h - 1.0)
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1)
        ax, ay = fx - x0, fy - y0
        i00, i10 = (y0 * w + x0) * 2, (y0 * w + x1) * 2
        i01, i11 = (y1 * w + x0) * 2, (y1 * w + x1) * 2
        dx = ((d[i00] * (1 - ax) + d[i10] * ax) * (1 - ay) + (d[i01] * (1 - ax) + d[i11] * ax) * ay) / 16.0
        dy = ((d[i00 + 1] * (1 - ax) + d[i10 + 1] * ax) * (1 - ay) + (d[i01 + 1] * (1 - ax) + d[i11 + 1] * ax) * ay) / 16.0
        return dx, dy


def apply_liquify(img, lmap):
    if lmap.bbox is None:
        return img
    W, H = img.size
    kx, ky = lmap.w / W, lmap.h / H            # image px -> field px
    cell = max(3, round(max(W, H) / 500))       # mesh resolution
    bx0, by0, bx1, by1 = lmap.bbox
    margin = 2 * cell
    x_start = max(0, int(bx0 / kx) - margin) // cell * cell
    y_start = max(0, int(by0 / ky) - margin) // cell * cell
    x_end = min(W, math.ceil((bx1 + 1) / kx) + margin)
    y_end = min(H, math.ceil((by1 + 1) / ky) + margin)

    xs = list(range(x_start, x_end, cell)) + [x_end]
    ys = list(range(y_start, y_end, cell)) + [y_end]
    # source position for every mesh vertex
    src = []
    for y in ys:
        row = []
        for x in xs:
            dx, dy = lmap.sample(x * kx, y * ky)
            sx = min(max(x + dx / kx, 0), W)
            sy = min(max(y + dy / ky, 0), H)
            row.append((sx, sy))
        src.append(row)

    mesh = []
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            ul, ur = src[j][i], src[j][i + 1]
            ll, lr = src[j + 1][i], src[j + 1][i + 1]
            mesh.append(((xs[i], ys[j], xs[i + 1], ys[j + 1]),
                         (ul[0], ul[1], ll[0], ll[1], lr[0], lr[1], ur[0], ur[1])))

    base_mode = img.mode
    warped = img.convert("RGBA").transform((W, H), Image.MESH, mesh, Image.BICUBIC)
    # warped is transparent outside the mesh area -> keep the original there
    region = (x_start, y_start, x_end, y_end)
    out = img.copy()
    patch = warped.crop(region)
    if base_mode == "RGBA":
        out.paste(patch, region[:2])
    else:
        out.paste(patch.convert("RGB"), region[:2])
    return out


def apply_op(img, op, scale=1.0, maps=None):
    """Apply one geometric/filter operation. `scale` is preview size / full size."""
    t = op.get("type")
    if t == "liquify":
        if maps is None:
            raise ValueError("Liquify data not available")
        return apply_liquify(img, maps("liquify", op["map"]))
    if t == "rotate":
        angle = float(op.get("angle", 0))
        if angle % 90 == 0:
            method = {90: Image.ROTATE_90, 180: Image.ROTATE_180, 270: Image.ROTATE_270}
            a = int(angle) % 360
            return img.transpose(method[a]) if a else img
        return img.rotate(angle, expand=True, resample=Image.BICUBIC,
                          fillcolor=(255, 255, 255, 0) if img.mode == "RGBA" else (255, 255, 255))
    if t == "flip":
        return ImageOps.mirror(img) if op.get("axis") == "h" else ImageOps.flip(img)
    if t == "crop":
        # Fractions (0..1) of the current image so it works at any size.
        w, h = img.size
        x0 = max(0, min(w, round(float(op["x"]) * w)))
        y0 = max(0, min(h, round(float(op["y"]) * h)))
        x1 = max(x0 + 1, min(w, round((float(op["x"]) + float(op["w"])) * w)))
        y1 = max(y0 + 1, min(h, round((float(op["y"]) + float(op["h"])) * h)))
        return img.crop((x0, y0, x1, y1))
    if t == "resize":
        tw = max(1, round(int(op["width"]) * scale))
        th = max(1, round(int(op["height"]) * scale))
        return img.resize((tw, th), Image.LANCZOS)
    if t == "filter":
        return apply_filter(img, op["name"], float(op.get("strength", 1.0)))
    raise ValueError(f"Unknown operation: {t}")


def _soft_mask(diff, threshold):
    """Map a difference image to a 0..255 'keep the original' mask with a soft ramp T..2T."""
    t = max(threshold, 0.5)
    lut = [0 if d <= t else 255 if d >= 2 * t else int((d - t) / t * 255) for d in range(256)]
    return diff.point(lut)


def denoise(rgb, adj, scale=1.0):
    """Lightroom-style noise reduction (Detail panel) using Pillow only.

    Works in YCbCr: Luminance smooths grain in Y, Color smooths colour blotches in Cb/Cr.
    Each smooths with a blur, then keeps the original wherever the blur changed a pixel by
    more than a noise threshold, so real edges and texture survive. `scale` is preview size
    / full size, so the preview looks like the full-size export.
    """
    lum = float(adj.get("nr_lum", 0)) / 100.0
    col = float(adj.get("nr_color", 0)) / 100.0
    if lum <= 0 and col <= 0:
        return rgb
    y, cb, cr = rgb.convert("YCbCr").split()

    if lum > 0:
        detail = float(adj.get("nr_lum_detail", 50)) / 100.0
        contrast = float(adj.get("nr_lum_contrast", 0)) / 100.0
        radius = (0.6 + 2.4 * lum) * scale
        if radius >= 0.3:
            blur = y.filter(ImageFilter.GaussianBlur(radius))
            thresh = (4 + 40 * lum) * (1 - 0.8 * detail)
            y = Image.composite(y, blur, _soft_mask(ImageChops.difference(y, blur), thresh))
            if contrast > 0:  # bring back mid-size contrast the smoothing flattened
                y = y.filter(ImageFilter.UnsharpMask(radius=max(1.0, 8 * scale),
                                                     percent=int(80 * contrast * lum), threshold=2))

    if col > 0:
        detail = float(adj.get("nr_color_detail", 50)) / 100.0
        smooth = float(adj.get("nr_color_smooth", 50)) / 100.0
        radius = (1 + 6 * col) * (1 + 2 * smooth) * scale
        if radius >= 0.3:
            cb_blur = cb.filter(ImageFilter.GaussianBlur(radius))
            cr_blur = cr.filter(ImageFilter.GaussianBlur(radius))
            diff = ImageChops.lighter(ImageChops.difference(cb, cb_blur), ImageChops.difference(cr, cr_blur))
            mask = _soft_mask(diff, (3 + 30 * col) * (1 - 0.8 * detail))
            cb = Image.composite(cb, cb_blur, mask)
            cr = Image.composite(cr, cr_blur, mask)

    return Image.merge("YCbCr", (y, cb, cr)).convert("RGB")


def apply_adjustments(img, adj, scale=1.0):
    """Slider values: 100 = unchanged. Noise reduction runs first, like in Lightroom."""
    if not adj:
        return img
    rgb, alpha = _rgb(img)
    rgb = denoise(rgb, adj, scale)
    for key, enh in (("brightness", ImageEnhance.Brightness),
                     ("contrast", ImageEnhance.Contrast),
                     ("saturation", ImageEnhance.Color),
                     ("sharpness", ImageEnhance.Sharpness)):
        v = float(adj.get(key, 100))
        if abs(v - 100) > 0.01:
            rgb = enh(rgb).enhance(v / 100.0)
    warmth = float(adj.get("warmth", 0))  # -100..100
    if abs(warmth) > 0.01:
        r, g, b = rgb.split()
        k = warmth / 100.0 * 0.25
        r = r.point(lambda p: min(255, max(0, int(p * (1 + k)))))
        b = b.point(lambda p: min(255, max(0, int(p * (1 - k)))))
        rgb = Image.merge("RGB", (r, g, b))
    return _merge(rgb, alpha)


def render_geometry(img, ops, max_side=None, maps=None):
    """Apply the operation list. If max_side is set, work on a downscaled copy (fast preview)."""
    scale = 1.0
    if max_side and max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    for op in ops or []:
        img = apply_op(img, op, scale, maps)
    return img, scale


def render(img, ops, adjustments, max_side=None, maps=None):
    img, scale = render_geometry(img, ops, max_side, maps)
    return apply_adjustments(img, adjustments, scale), scale
