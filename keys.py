"""Keep the API keys in git safely: API.txt is encrypted into API.enc.

API.enc is committed; it is useless without the secret key in secret.key
(git-ignored, created the first time you run "lock"). Copy secret.key to the
server once (or put its text in the PHOTOEDITOR_SECRET environment variable);
the app then reads the keys straight from API.enc.

    python keys.py lock     API.txt  -> API.enc   (after you change a key)
    python keys.py unlock   API.enc  -> API.txt   (optional, e.g. on a new machine)
"""
import os
import sys

from cryptography.fernet import Fernet, InvalidToken

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLAIN = os.path.join(BASE_DIR, "API.txt")
LOCKED = os.path.join(BASE_DIR, "API.enc")
SECRET = os.path.join(BASE_DIR, "secret.key")
ENV = "PHOTOEDITOR_SECRET"


def _secret(create=False):
    if os.environ.get(ENV, "").strip():
        return os.environ[ENV].strip().encode()
    if os.path.exists(SECRET):
        with open(SECRET, "rb") as f:
            return f.read().strip()
    if not create:
        return None
    key = Fernet.generate_key()
    with open(SECRET, "wb") as f:
        f.write(key + b"\n")
    print("Created secret.key - keep a copy somewhere safe and copy it to the server. It is NOT in git.")
    return key


def decrypt():
    """Text of API.enc, or None if there is no API.enc or no secret for it."""
    secret = _secret()
    if not secret or not os.path.exists(LOCKED):
        return None
    with open(LOCKED, "rb") as f:
        data = f.read().strip()
    try:
        return Fernet(secret).decrypt(data).decode("utf-8")
    except (InvalidToken, ValueError):
        raise ValueError("API.enc could not be decrypted - secret.key does not match it") from None


def lock():
    if not os.path.exists(PLAIN):
        sys.exit("API.txt not found - nothing to encrypt")
    with open(PLAIN, "rb") as f:
        data = f.read()
    token = Fernet(_secret(create=True)).encrypt(data)
    with open(LOCKED, "wb") as f:
        f.write(token + b"\n")
    print("API.txt encrypted into API.enc - commit and push API.enc.")


def unlock():
    text = decrypt()
    if text is None:
        sys.exit("Need API.enc and secret.key (or the PHOTOEDITOR_SECRET variable)")
    with open(PLAIN, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print("API.enc decrypted into API.txt")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "lock":
        lock()
    elif cmd == "unlock":
        unlock()
    else:
        print(__doc__)
