"""AI command box: turns a sentence like "make it warmer and brighter" into slider values.

Two hosted providers are supported (no local model, so it runs fine on a small VPS):
  - Groq   (free tier)  key: GROQ_API_KEY
  - Gemini (free tier)  key: GEMINI_API_KEY
The model is picked in the UI from the free-tier models listed in PROVIDERS below
(checked November 2026). GROQ_MODEL / GEMINI_MODEL add one more model to the list.

Keys are read from environment variables first, then from API.txt next to this file
(git-ignored), then from API.enc, the encrypted copy kept in git (see keys.py). One per line, e.g.
    Groq API Key: gsk_...
    Gemini API Key: AIza...
Only the standard library is used for the HTTP calls.
"""
import json
import os
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(BASE_DIR, "API.txt")
TIMEOUT = 30

# slider key -> (min, max, default, meaning) ; must match templates/index.html
SLIDERS = {
    "brightness": (0, 200, 100, "100 = unchanged, lower = darker, higher = brighter"),
    "contrast": (0, 200, 100, "100 = unchanged"),
    "saturation": (0, 200, 100, "100 = unchanged, 0 = black and white"),
    "sharpness": (0, 300, 100, "100 = unchanged, below 100 softens"),
    "warmth": (-100, 100, 0, "0 = neutral, positive = warmer/orange, negative = cooler/blue"),
    "nr_lum": (0, 100, 0, "luminance noise reduction amount (grain), 0 = off"),
    "nr_lum_detail": (0, 100, 50, "detail kept by luminance noise reduction"),
    "nr_lum_contrast": (0, 100, 0, "contrast restored after luminance noise reduction"),
    "nr_color": (0, 100, 0, "color noise reduction amount, 0 = off"),
    "nr_color_detail": (0, 100, 50, "detail kept by color noise reduction"),
    "nr_color_smooth": (0, 100, 50, "smoothness of color noise reduction"),
}

# Free-tier text models, first one is the default. Labels show the free limits
# (requests per minute / per day). Llama 3.x was removed from Groq's free tier in
# August 2026, and Gemini 2.5 is only open to accounts that used it before.
PROVIDERS = {
    "groq": {"label": "Groq", "env": ["GROQ_API_KEY"], "file": ["groq"], "model_env": "GROQ_MODEL", "models": [
        ("openai/gpt-oss-120b", "GPT-OSS 120B (30/min, 1000/day)"),
        ("openai/gpt-oss-20b", "GPT-OSS 20B (30/min, 1000/day)"),
        ("qwen/qwen3.6-27b", "Qwen 3.6 27B (30/min, 1000/day)"),
        ("qwen/qwen3.8-27b", "Qwen 3.8 27B preview (30/min, 1000/day)"),
    ]},
    "gemini": {"label": "Google Gemini", "env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"], "file": ["gemini", "google"],
               "model_env": "GEMINI_MODEL", "models": [
        ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite (15/min, 500/day)"),
        ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite (15/min, 500/day)"),
        ("gemini-3.8-flash", "Gemini 3.8 Flash (5/min, 20/day)"),
        ("gemini-3.6-flash", "Gemini 3.6 Flash (5/min, 20/day)"),
        ("gemini-3-flash-preview", "Gemini 3 Flash preview (5/min, 20/day)"),
    ]},
}


class AIError(Exception):
    pass


def _key_lines():
    """Lines of API.txt, or else of the encrypted API.enc (see keys.py)."""
    try:
        with open(KEY_FILE, encoding="utf-8-sig") as f:
            return f.read().splitlines()
    except OSError:
        pass
    try:
        import keys
        text = keys.decrypt()
    except (ImportError, ValueError):
        return []
    return (text or "").lstrip("\ufeff").splitlines()


def _keys_from_file():
    keys = {}
    for line in _key_lines():
        if ":" not in line and "=" not in line:
            continue
        sep = ":" if ":" in line else "="
        name, value = line.split(sep, 1)
        name, value = name.strip().lower(), value.strip().strip('"').strip("'")
        for pid, p in PROVIDERS.items():
            if value and any(word in name for word in p["file"]):
                keys.setdefault(pid, value)
    return keys


def _key(pid):
    p = PROVIDERS[pid]
    for env in p["env"]:
        if os.environ.get(env, "").strip():
            return os.environ[env].strip()
    return _keys_from_file().get(pid)


def _models(pid):
    p = PROVIDERS[pid]
    models = list(p["models"])
    extra = os.environ.get(p["model_env"], "").strip()
    if extra and extra not in dict(models):
        models.insert(0, (extra, f"{extra} (from {p['model_env']})"))
    return models


def providers():
    """For the UI: which providers exist, which have a key, and their free models."""
    return [{"id": pid, "label": p["label"], "ready": bool(_key(pid)),
             "models": [{"id": m, "label": lbl} for m, lbl in _models(pid)]}
            for pid, p in PROVIDERS.items()]


def _system_prompt():
    lines = [f'- "{k}": {lo}..{hi} (default {d}; {m})' for k, (lo, hi, d, m) in SLIDERS.items()]
    return (
        "You control the adjustment sliders of a photo editor. The user describes, in any language "
        "(often Persian or English), how they want the photo to look. You get the current slider values "
        "and return new ones.\n\nSliders:\n" + "\n".join(lines) + "\n\n"
        "Rules:\n"
        "- Start from the CURRENT values and change only what the request asks for; keep the rest.\n"
        "- Make moderate, photographic changes: 'a bit' = about 5-10, plain request = about 10-25, "
        "'a lot'/'much' = about 30-50 away from the current value.\n"
        "- 'reset'/'original' means the defaults.\n"
        "- If a request cannot be done with these sliders, change nothing and say so in the note.\n"
        'Reply with JSON only: {"adjustments": {<only the sliders you changed>: number}, '
        '"note": "<one short sentence in the user\'s language describing what you changed>"}'
    )


def _post(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Accept": "application/json",
                                 "User-Agent": "PhotoEditor/1.0", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            err = json.loads(detail).get("error")
            detail = err.get("message", detail) if isinstance(err, dict) else (err or detail)
        except (ValueError, AttributeError):
            pass
        if e.code == 429:
            raise AIError("Free-tier limit reached for this model - wait a minute, or pick another model") from None
        if e.code == 404 or "decommissioned" in str(detail) or "not found" in str(detail).lower():
            raise AIError(f"This model is not available to your key: {str(detail)[:160]}") from None
        if e.code == 401 or "api key" in str(detail).lower():
            raise AIError(f"The API key was rejected ({str(detail)[:120]}) - check it in API.txt") from None
        if e.code == 403:
            raise AIError(f"Access refused by the provider (403): {str(detail)[:160]}") from None
        raise AIError(f"Provider error {e.code}: {str(detail)[:200]}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise AIError(f"Could not reach the provider: {getattr(e, 'reason', e)}") from None


def _ask_groq(key, model, system, user):
    data = _post("https://api.groq.com/openai/v1/chat/completions", {"Authorization": f"Bearer {key}"}, {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        **({"reasoning_effort": "low"} if model.startswith("openai/gpt-oss") else {}),
        **({"reasoning_format": "hidden"} if model.startswith("qwen/") else {}),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    })
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise AIError("Unexpected reply from Groq") from None


def _ask_gemini(key, model, system, user):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    data = _post(url, {"x-goog-api-key": key}, {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
    })
    try:
        return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
    except (KeyError, IndexError, TypeError):
        raise AIError("Unexpected reply from Gemini (the request may have been blocked)") from None


def _parse(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise AIError("The AI did not return slider values")
    try:
        return json.loads(text[start:end + 1])
    except ValueError:
        raise AIError("The AI returned something that is not valid JSON") from None


def command(provider, text, current, model=None):
    """Return (new_adjustments, note). Values are clamped to each slider's range."""
    if provider not in PROVIDERS:
        raise AIError(f"Unknown AI provider: {provider}")
    models = dict(_models(provider))
    model = model if model in models else next(iter(models))
    text = (text or "").strip()
    if not text:
        raise AIError("Type what you want to change")
    if len(text) > 500:
        raise AIError("Please keep the request under 500 characters")
    key = _key(provider)
    if not key:
        p = PROVIDERS[provider]
        raise AIError(f"No API key for {p['label']}: set {p['env'][0]} or add '{p['label'].split()[-1]} API Key: ...' to API.txt")

    cur = {}
    for k, (lo, hi, d, _) in SLIDERS.items():
        try:
            cur[k] = min(hi, max(lo, float((current or {}).get(k, d))))
        except (TypeError, ValueError):
            cur[k] = d
    user = "Current values: " + json.dumps({k: round(v, 1) for k, v in cur.items()}) + "\nRequest: " + text

    ask = _ask_groq if provider == "groq" else _ask_gemini
    reply = _parse(ask(key, model, _system_prompt(), user))
    changes = reply.get("adjustments") if isinstance(reply.get("adjustments"), dict) else {}

    new = dict(cur)
    for k, v in changes.items():
        if k in SLIDERS:
            lo, hi = SLIDERS[k][:2]
            try:
                new[k] = round(min(hi, max(lo, float(v))))
            except (TypeError, ValueError):
                pass
    note = str(reply.get("note") or "")[:300]
    return new, note
