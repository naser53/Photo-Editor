#!/usr/bin/env bash
# PhotoEditor - first-time install on an Ubuntu VPS (tested for Ubuntu 26.04).
# Run as root:   sudo bash setup_vps.sh
# Safe to run again later: it updates the code and restarts the app.
#
# It lives alongside other sites on the same server: it only adds its own nginx
# site file and never changes or removes existing ones.
#   - default: the editor is served on its own port, http://SERVER_IP:8090
#   - with a domain:  sudo DOMAIN=photo.example.com bash setup_vps.sh
#     serves it on port 80 for that domain only (point the domain's DNS to the server first)
set -euo pipefail

REPO="https://github.com/naser53/photo-editor.git"
APP_DIR="/opt/photo-editor"
APP_USER="photoeditor"
PORT="${APP_PORT:-8765}"         # internal port, only reachable from the server itself
PUBLIC_PORT="${PUBLIC_PORT:-8090}" # port people open in the browser (when no DOMAIN is given)
DOMAIN="${DOMAIN:-}"

port_taken() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }

echo "== 1. System packages"
apt-get update -y
apt-get install -y git python3 python3-venv python3-pip openssl iproute2
if ! command -v nginx >/dev/null; then
  # A fresh nginx wants port 80; if another web server already has it, drop nginx's
  # own "default" welcome site so nginx can start next to it.
  apt-get install -y nginx || true
  if port_taken 80 && ! pgrep -x nginx >/dev/null; then rm -f /etc/nginx/sites-enabled/default; fi
  dpkg --configure -a
fi

echo "== 2. App user and folder"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/uploads"

echo "== 3. Python environment"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt" gunicorn

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if ! systemctl is-active --quiet photoeditor && port_taken "$PORT"; then
  echo "Port $PORT is already used by another program. Run again with another one, e.g.: sudo APP_PORT=8766 bash $0"
  exit 1
fi

echo "== 4. Background service (starts on boot, restarts if it crashes)"
# One worker: the app keeps the open photo in memory, so all requests must reach the same process.
cat > /etc/systemd/system/photoeditor.service <<UNIT
[Unit]
Description=PhotoEditor
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/gunicorn --workers 1 --threads 4 --timeout 120 --bind 127.0.0.1:$PORT app:app
Restart=always
MemoryMax=1200M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now photoeditor
systemctl restart photoeditor

echo "== 5. Website login (so strangers cannot use your AI quota)"
if [ ! -f /etc/nginx/photoeditor.htpasswd ]; then
  read -rp "Choose a login username: " WEB_USER
  read -rsp "Choose a login password: " WEB_PASS; echo
  printf '%s:%s\n' "$WEB_USER" "$(openssl passwd -apr1 "$WEB_PASS")" > /etc/nginx/photoeditor.htpasswd
  chown root:www-data /etc/nginx/photoeditor.htpasswd
  chmod 640 /etc/nginx/photoeditor.htpasswd
fi

if [ -n "$DOMAIN" ]; then
  LISTEN_PORT=80; SERVER_NAME="$DOMAIN"; URL="http://$DOMAIN/"
else
  LISTEN_PORT="$PUBLIC_PORT"; SERVER_NAME="_"; URL="http://$(hostname -I | awk '{print $1}'):$PUBLIC_PORT/"
  if [ ! -f /etc/nginx/sites-available/photoeditor ] && port_taken "$PUBLIC_PORT"; then
    echo "Port $PUBLIC_PORT is already in use. Run again with another one, e.g.: sudo PUBLIC_PORT=8091 bash $0"
    exit 1
  fi
fi

echo "== 6. nginx site (your other sites are left untouched)"
cat > /etc/nginx/sites-available/photoeditor <<NGINX
server {
    listen $LISTEN_PORT;
    listen [::]:$LISTEN_PORT;
    server_name $SERVER_NAME;
    client_max_body_size 50M;

    auth_basic "PhotoEditor";
    auth_basic_user_file /etc/nginx/photoeditor.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/photoeditor /etc/nginx/sites-enabled/photoeditor
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/photoeditor
  echo "nginx rejected the new site, so it was switched off again and nothing else was changed."
  exit 1
fi
systemctl enable --now nginx
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$LISTEN_PORT/tcp"; fi

echo
echo "Done. Open $URL in your browser."
[ -z "$DOMAIN" ] && echo "(If your VPS provider has its own firewall panel, open port $PUBLIC_PORT there too.)"
if [ ! -f "$APP_DIR/secret.key" ] && [ ! -f "$APP_DIR/API.txt" ]; then
  echo
  echo "The AI box needs your keys: copy secret.key from your PC to $APP_DIR/ , then run:"
  echo "  sudo chown $APP_USER:$APP_USER $APP_DIR/secret.key && sudo chmod 600 $APP_DIR/secret.key"
fi
