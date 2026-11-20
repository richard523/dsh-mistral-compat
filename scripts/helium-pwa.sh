#!/bin/sh
# dsh-helium-pwa — launch the DeepSeek Harness web UI as a standalone Helium
# app window (dedicated browser profile, so it stays an app next to the main
# browser). When run from a repository checkout, always serves THAT checkout:
# backend straight from source and the web frontend rebuilt whenever its
# sources are newer than the built bundle, so the checkout is the source of
# truth and no reinstall is ever needed. A stale dsh server from a different
# install on the same port is replaced; anything else on the port is left
# alone with a warning.
#
#   dsh-helium-pwa            start (if needed) and open the app window
#   dsh-helium-pwa install    install the .desktop entry + icon for the user
#
# Environment:
#   DSH_PORT    web UI port (default 3080)
#   DSH_BIN     run an explicit dsh binary instead of the checkout
#   DSH_BIN=installed  run the default user install (~/.local/lib/node_modules)
#               instead of the checkout
#   HELIUM_BIN  Helium binary (default: `helium-browser` from PATH; /bin/true
#               for headless smoke tests)
set -u

PORT="${DSH_PORT:-3080}"
BASE="http://127.0.0.1:${PORT}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
LOG="$DSH_HOME_DIR/logs/pwa-server.log"
HELIUM="${HELIUM_BIN:-$(command -v helium-browser || true)}"
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/helium-dsh-pwa"

# Resolve the script through symlinks (e.g. ~/.local/bin/dsh-helium-pwa) so the
# checkout that owns this script is what we run.
script="$0"
if resolved=$(readlink -f -- "$0" 2>/dev/null) && [ -n "$resolved" ]; then
  script="$resolved"
fi
here=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$here/.." && pwd)
CLI_SRC="$REPO_ROOT/apps/cli/src/bin.ts"
BUN=$(command -v bun || true)

if [ "${1:-}" = "install" ]; then
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

# Server run mode: checkout source (default from a checkout), an explicit
# DSH_BIN, or the classic install resolution.
if [ -n "${DSH_BIN:-}" ] && [ "$DSH_BIN" != "installed" ]; then
  RUN_MODE="bin"
  RUN_BIN="$DSH_BIN"
elif [ -z "${DSH_BIN:-}" ] && [ -f "$CLI_SRC" ] && [ -n "$BUN" ]; then
  RUN_MODE="source"
elif [ -n "${DSH_BIN:-}" ] || ! command -v dsh >/dev/null 2>&1; then
  RUN_MODE="bin"
  RUN_BIN="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
  [ -f "$RUN_BIN" ] || RUN_BIN=""
else
  RUN_MODE="bin"
  RUN_BIN=$(command -v dsh)
fi

# Pid of the process listening on $PORT, if any.
port_pid() {
  ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d'=' -f2
}

pid_cmdline() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null
}

cmd_has() {
  case "$CMD" in *"$1"*) return 0;; *) return 1;; esac
}

# Rebuild the web frontend when its sources are newer than the built bundle
# (or no bundle exists). Failure is logged but non-fatal: the server keeps
# serving the previous bundle.
maybe_rebuild_frontend() {
  [ "$RUN_MODE" = "source" ] || return 0
  command -v pnpm >/dev/null 2>&1 || return 0
  dist="$REPO_ROOT/apps/web/dist/index.html"
  if [ ! -f "$dist" ] \
    || find "$REPO_ROOT/apps/web/src" "$REPO_ROOT/apps/web/public" \
        "$REPO_ROOT/apps/web/index.html" "$REPO_ROOT/apps/web/vite.config.ts" \
        -newer "$dist" -print -quit 2>/dev/null | grep -q .; then
    echo "dsh-helium-pwa: web frontend stale, rebuilding..." >&2
    (cd "$REPO_ROOT" && pnpm run build:web) >&2 \
      || echo "dsh-helium-pwa: web frontend rebuild failed, serving previous bundle" >&2
  fi
}

start_server() {
  mkdir -p "$(dirname "$LOG")"
  # Only trust token URLs logged after this point: earlier lines may come from
  # a previous server instance that no longer exists.
  STARTPOS=$(wc -c < "$LOG" 2>/dev/null); STARTPOS=$(( ${STARTPOS:-0} + 0 ))
  maybe_rebuild_frontend
  if [ "$RUN_MODE" = "source" ]; then
    setsid nohup "$BUN" --expose-internals --import tsx/esm "$CLI_SRC" web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  elif [ -n "${RUN_BIN:-}" ]; then
    setsid nohup "$BUN" --expose-internals "$RUN_BIN" web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  else
    setsid nohup bunx --bun @deepseek-ai/dsh web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &
  fi
}

# Wait until $PORT is free (after killing a stale server), bounded by $1 seconds.
wait_port_free() {
  i=0
  while [ "$i" -lt "$1" ] && [ -n "$(port_pid)" ]; do
    i=$((i + 1)); sleep 1
  done
}

# Set $url to the tokenized base URL once the server announces it.
wait_token_url() {
  url=""
  if [ -z "${STARTPOS:-}" ]; then
    # Not our start: only trust token URLs logged from this call onward.
    STARTPOS=$(wc -c < "$LOG" 2>/dev/null); STARTPOS=$(( ${STARTPOS:-0} + 0 ))
  fi
  i=0
  while [ "$i" -lt 45 ]; do
    i=$((i + 1)); sleep 1
    url=$(tail -c +$((STARTPOS + 1)) "$LOG" 2>/dev/null \
      | grep -o "http://127\\.0\\.0\\.1:${PORT}/?token=[A-Za-z0-9_-]*" | tail -1)
    [ -n "$url" ] && break
  done
}

# Complain clearly when nothing ended up listening on $PORT.
check_server_up() {
  probe=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE" 2>/dev/null); probe=${probe:-000}
  if [ "$probe" = "000" ] || [ "$probe" = "404" ]; then
    echo "dsh-helium-pwa: server failed to start on port $PORT (see $LOG)" >&2
    command -v notify-send >/dev/null 2>&1 \
      && notify-send -u critical "DeepSeek Harness" "Server failed to start on port $PORT — see $LOG"
    url="$BASE"
  fi
}

code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE" 2>/dev/null); code=${code:-000}; [ -z "$code" ] && code=000
url="$BASE"

# Who holds the port: our server, a stale dsh from another install, or an
# unrelated listener.
LISTENER_PID=$(port_pid)
CMD=$(pid_cmdline "$LISTENER_PID")

if [ -n "$LISTENER_PID" ] && [ "$RUN_MODE" = "source" ] && cmd_has "$CLI_SRC"; then
  listener="ours"
elif [ -n "$LISTENER_PID" ] && [ "$RUN_MODE" = "bin" ] && [ -n "${RUN_BIN:-}" ] && cmd_has "$RUN_BIN"; then
  listener="ours"
elif [ -n "$LISTENER_PID" ] && cmd_has 'node_modules/@deepseek-ai/dsh'; then
  listener="stale-dsh"
elif [ -n "$LISTENER_PID" ]; then
  listener="unrelated"
else
  listener="none"
fi

started_new="no"

if [ "$listener" = "ours" ]; then
  if [ "$code" = "000" ]; then
    # Still booting (e.g. a second click right after the first): wait it out.
    wait_token_url
    check_server_up
    url="${url:-$BASE}"
  fi
elif [ "$listener" = "stale-dsh" ]; then
  echo "dsh-helium-pwa: replacing stale dsh server (pid $LISTENER_PID) on port $PORT" >&2
  kill "$LISTENER_PID" 2>/dev/null
  wait_port_free 10
  if [ -n "$(port_pid)" ]; then
    kill -9 "$LISTENER_PID" 2>/dev/null
    wait_port_free 5
  fi
  if [ -z "$(port_pid)" ]; then
    start_server
    wait_token_url
    check_server_up
    url="${url:-$BASE}"
    started_new="yes"
  else
    echo "dsh-helium-pwa: could not free port $PORT; opening the running server as-is" >&2
  fi
elif [ "$listener" = "unrelated" ]; then
  if [ "$code" = "000" ]; then
    echo "dsh-helium-pwa: port $PORT is held by an unrelated listener; cannot start the server" >&2
  else
    echo "dsh-helium-pwa: port $PORT is held by an unrelated server; opening it as-is" >&2
  fi
else
  start_server
  wait_token_url
  check_server_up
  url="${url:-$BASE}"
  started_new="yes"
fi

# Fresh token URL when the stored profile has no valid session cookie and we
# did not already collect one for a server we just started.
if [ "$code" = "401" ] && [ "$started_new" != "yes" ]; then
  t=$(tail -c 20000 "$LOG" 2>/dev/null \
    | grep -o "http://127\\.0\\.0\\.1:${PORT}/?token=[A-Za-z0-9_-]*" | tail -1)
  [ -n "$t" ] && url="$t"
fi

exec "$HELIUM" --user-data-dir="$PROFILE" --class=deepseek-harness --app="$url"
