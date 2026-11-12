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

## Install on an Ubuntu VPS

```
curl -fsSL https://raw.githubusercontent.com/naser53/photo-editor/main/deploy/setup_vps.sh -o setup_vps.sh
sudo bash setup_vps.sh
```

It installs everything into `/opt/photo-editor` and runs the app as a service behind nginx with a login,
at `http://SERVER_IP:8090`. With a domain: `sudo DOMAIN=photo.example.com bash setup_vps.sh` serves it on
port 80 for that domain. Other nginx sites on the server are left untouched. Run it again later to update. Copy `secret.key` to `/opt/photo-editor/` once for the AI keys.

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
- AI command box: type what you want ("make it warmer and a bit brighter", in English or Persian) and an
  AI sets the Adjust and Noise reduction sliders for you; an "undo" link puts them back. Pick the provider
  (Groq or Google Gemini, both have a free tier) and model in the box. See *AI keys* below
- Undo / redo (Ctrl+Z / Ctrl+Y), edit history, hold-to-compare with the original
- Download as JPG, PNG or WEBP at full resolution

## AI keys

The AI command box needs an API key for at least one provider. Either set environment variables
(`GROQ_API_KEY`, `GEMINI_API_KEY`) or put them in `API.txt` next to `app.py`, one per line:

```
Groq API Key: gsk_...
Gemini API Key: AIza...
```

`API.txt` itself is git-ignored. Free keys: https://console.groq.com/keys and
https://aistudio.google.com/apikey. Pick the model in the box: only free-tier models are listed
(Groq: GPT-OSS 120B/20B, Qwen 3.6/3.8; Gemini: 3.5 and 3.1 Flash-Lite, 3.8, 3.6 and 3 Flash).
`GROQ_MODEL` / `GEMINI_MODEL` add one more model to the list. After adding a key to API.txt, reload the page (environment variables need an app restart).

### Keys in git (encrypted)

The keys are kept in the repository only in encrypted form, in `API.enc`. The secret that unlocks
them is `secret.key`, which is git-ignored and must never be pushed.

- After you change a key in `API.txt`, double-click **lock_keys.bat** (or run `python keys.py lock`),
  then commit and push `API.enc`.
- On a server or a new machine: `git pull`, then copy `secret.key` there once (or put its text in the
  `PHOTOEDITOR_SECRET` environment variable). The app reads the keys straight from `API.enc`;
  `python keys.py unlock` writes them back to `API.txt` if you want the plain file.
- Lost `secret.key`? Make a new one by deleting it and running lock_keys.bat again, then push the new `API.enc`.

## Files

- `app.py` – Flask server and API (`/api/upload`, `/api/render`, `/api/export`)
- `keys.py`, `lock_keys.bat` – encrypt `API.txt` into `API.enc` (kept in git) and read it back
- `ai.py` – the AI command box: sends your sentence to Groq or Gemini and returns slider values
- `editor.py` – the Pillow editing pipeline (including noise reduction and the liquify mesh warp)
- `templates/index.html`, `static/style.css`, `static/app.js`, `static/liquify.js` – the web page
- `uploads/` – photos you open are stored here (safe to empty; not included in the repository)
