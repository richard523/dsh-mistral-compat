#!/bin/sh
# dsh-helium-pwa — launch the DeepSeek Harness web UI as a standalone Helium
# app window (dedicated browser profile, so it stays an app next to the main
# browser). Generic launcher: resolves the dsh binary and Helium from PATH.
#
#   dsh-helium-pwa            start (if needed) and open the app window
#   dsh-helium-pwa install    install the .desktop entry + icon for the user
#
# Environment:
#   DSH_PORT    web UI port (default 3080)
#   DSH_BIN     dsh bin to run (default: `dsh` from PATH, else the default
#               user install location, else `bunx @deepseek-ai/dsh`)
#   HELIUM_BIN  Helium binary (default: `helium-browser` from PATH)
set -u

PORT="${DSH_PORT:-3080}"
BASE="http://127.0.0.1:${PORT}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
LOG="$DSH_HOME_DIR/logs/pwa-server.log"
HELIUM="${HELIUM_BIN:-$(command -v helium-browser || true)}"
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/helium-dsh-pwa"

if [ "${1:-}" = "install" ]; then
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$apps" "$icons" "$HOME/.local/bin"
  cp "$here/../assets/linux/deepseek-harness.desktop" "$apps/deepseek-harness.desktop"
  cp "$here/../apps/web/public/icon-512.png" "$icons/deepseek-harness.png"
  ln -sf "$here/helium-pwa.sh" "$HOME/.local/bin/dsh-helium-pwa"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" || true
  echo "installed: $apps/deepseek-harness.desktop (Exec=dsh-helium-pwa) + icon + ~/.local/bin/dsh-helium-pwa"
  exit 0
fi

if [ -z "$HELIUM" ]; then
  echo "dsh-helium-pwa: helium-browser not found on PATH (set HELIUM_BIN)" >&2
  exit 1
fi

if [ -n "${DSH_BIN:-}" ]; then
  BIN="$DSH_BIN"
elif command -v dsh >/dev/null 2>&1; then
  BIN=$(command -v dsh)
elif [ -f "$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  BIN="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
else
  BIN=""
fi

start_server() {
  mkdir -p "$(dirname "$LOG")"
  if [ -n "$BIN" ]; then
    setsid nohup bun --expose-internals "$BIN" web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  else
    setsid nohup bunx --bun @deepseek-ai/dsh web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  fi
}

code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE" 2>/dev/null); code=${code:-000}; [ -z "$code" ] && code=000
url="$BASE"

if [ "$code" = "000" ]; then
  start_server
  i=0
  while [ "$i" -lt 30 ]; do
    i=$((i + 1)); sleep 1
    url=$(grep -o "http://127\.0\.0\.1:${PORT}/?token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | tail -1)
    [ -n "$url" ] && break
  done
  [ -n "$url" ] || url="$BASE"
elif [ "$code" = "401" ]; then
  t=$(grep -o "http://127\.0\.0\.1:${PORT}/?token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | tail -1)
  [ -n "$t" ] && url="$t"
fi

exec "$HELIUM" --user-data-dir="$PROFILE" --class=deepseek-harness --app="$url"
