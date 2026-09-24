#!/bin/sh
set -eu

APP_DIR=${APP_DIR:-/home/user/novita-dashboard}
REPO_URL=${REPO_URL:-https://github.com/digitalshare/novita-dashboard.git}
BRANCH=${BRANCH:-master}
PORT=${PORT:-4173}

if [ "$(id -u)" -eq 0 ]; then
  SUDO=
else
  SUDO="sudo -n"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  $SUDO sh -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  $SUDO apt-get install -y nodejs
fi

cd "$APP_DIR"
/usr/bin/npm ci --omit=dev

if [ -f "$APP_DIR/server.pid" ] && kill -0 "$(cat "$APP_DIR/server.pid")" 2>/dev/null; then
  kill "$(cat "$APP_DIR/server.pid")"
fi

PORT="$PORT" nohup /usr/bin/node server.js > "$APP_DIR/server.log" 2>&1 &
echo $! > "$APP_DIR/server.pid"

sleep 2
curl -fsS -o /dev/null "http://localhost:$PORT/"
printf 'Dashboard started at commit %s on port %s\n' "$(git rev-parse HEAD)" "$PORT"
