# PhotoEditor

A small web app for loading and editing photos, built with Python (Flask + Pillow).

## Start it (Windows)

Double-click **run.bat**. The first time it:

1. finds your Python installation,
2. creates a private environment in `.venv`,
3. installs Flask and Pillow,
4. starts the server and opens http://127.0.0.1:5000 in your browser.

Close the black window to stop the server.

Manual start: `pip install -r requirements.txt` then `python app.py`.

## Features

- Open a photo (button or drag & drop): JPG, PNG, WEBP, BMP, GIF, TIFF
- Rotate left/right, flip, straighten (free angle)
- Crop with free or fixed ratio (1:1, 4:3, 3:2, 16:9, 4:5)
- Resize with proportion lock
- Zoom in/out: mouse wheel (zooms at the cursor), the − / + buttons, type a zoom %, Fit, 100%;
  Ctrl + / Ctrl − / Ctrl 0 (fit) / Ctrl 1 (100%). Pan by dragging, with Space + drag, or the middle mouse button
- Brightness, contrast, saturation, sharpness, warmth sliders, each with a number box (type a value or drag;
  both stay in sync). Double-click a slider to reset it
- Noise reduction (like Lightroom's Detail panel): Luminance with Detail and Contrast, Color with Detail and
  Smoothness. Shown in the live preview and applied to the full-size download
- Liquify (like Photoshop): Forward Warp, Reconstruct, Smooth, Twirl ↻/↺, Pucker, Bloat with Size, Strength,
  Density, Rate and Stroke smoothing; stroke undo/redo, Restore all. Keys: W R E C (Alt+C) S B, [ ] for size,
  Enter to apply, Esc to cancel. The warp is applied to the full-resolution photo on download
- Filters: B&W, sepia, vignette, auto fix, sharpen, blur, smooth, equalize, posterize, invert, emboss, edges
- Undo / redo (Ctrl+Z / Ctrl+Y), edit history, hold-to-compare with the original
- Download as JPG, PNG or WEBP at full resolution

## Files

- `app.py` – Flask server and API (`/api/upload`, `/api/render`, `/api/export`)
- `editor.py` – the Pillow editing pipeline (including noise reduction and the liquify mesh warp)
- `templates/index.html`, `static/style.css`, `static/app.js`, `static/liquify.js` – the web page
- `uploads/` – photos you open are stored here (safe to empty; not included in the repository)
