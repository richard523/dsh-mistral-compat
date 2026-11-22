#!/bin/sh
# dsh-helium-pwa — launch the DeepSeek Harness web UI as a standalone Helium
# app window (dedicated browser profile, so it stays an app next to the main
# browser). When run from a repository checkout, always serves THAT checkout:
# backend straight from source and the web frontend rebuilt whenever its
# sources are newer than the built bundle, so the checkout is the source of
# truth and no reinstall is ever needed. New Mistral Vibe CLI sessions are
# imported on the way (scripts/import-vibe.mjs --new-only, honoring the
# importer's server-stopped contract), so chats from the Vibe CLI show up in
# the sidebar with every click. The window's Le Chat pane (the Mistral-mark
# button, Ctrl+Alt+M) embeds chat.mistral.ai live: the window is opened with a
# loopback DevTools port and scripts/lechat-frame-permit.mjs runs beside it,
# stripping Le Chat's frame-blocking headers from document responses only.
# The daemon is also the pane's keyboard usher: opening the pane (Ctrl+Alt+M,
# the Mistral button) moves the keyboard into Le Chat and focuses its
# composer, so typing starts immediately; Escape or Ctrl+Alt+M again — from
# either side of the origin — closes the pane and puts the keyboard back on
# the dsh chat composer. The daemon also launders the top-level Le Chat
# sign-in into the pane's third-party cookie partition, so signing in once
# via the pane header's ↗ window signs the pane in as well. The window is an X11 ozone surface
# (--ozone-platform=x11): Chromium 155 native-Wayland does not take its
# app_id from --class, so GNOME could not associate the window with the
# .desktop entry (generic icon, no dash link); under X11 WM_CLASS res_class
# == --class and StartupWMClass matching works (the helium-discord-pwa app
# proved this path live). --password-store=basic keeps the GNOME keyring out
# of the startup path. A stale dsh server from a different install on the same port is replaced;
# anything else on the port is left alone with a warning.
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
#   DSH_LECHAT_CDP_PORT  loopback DevTools port for the Le Chat frame permit
#               (default 3130)
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
VIBE_STORE="${VIBE_HOME:-$HOME/.vibe/logs/session}"
VIBE_IMPORT_STATE="$DSH_HOME_DIR/logs/vibe-import.state"
LECHAT_CDP_PORT="${DSH_LECHAT_CDP_PORT:-3130}"
LECHAT_PERMIT="$DSH_HOME_DIR/logs/lechat-frame-permit"

if [ "${1:-}" = "install" ]; then
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$apps" "$icons" "$HOME/.local/bin"
  cp "$here/../assets/linux/deepseek-harness.desktop" "$apps/deepseek-harness.desktop"
  cp "$here/../apps/web/public/icon-512.png" "$icons/deepseek-harness.png"
  # Icon= by absolute path, not theme name: theme-name lookup invites generic
  # fallbacks when the name misses (the Zed entry set this precedent).
  sed -i "s|^Icon=.*|Icon=$icons/deepseek-harness.png|" "$apps/deepseek-harness.desktop"
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
    # Run the server FROM THE CHECKOUT: bun resolves the tsx/esm preload (and
    # the CLI's workspace deps) against the server's own cwd, and a desktop
    # launch inherits $HOME — where no tsx is resolvable (~/node_modules has
    # stray non-workspace packages and a ~/package.json beside it), so the
    # server died instantly with `preload not found "tsx/esm"` and the window
    # opened at a dead port. The checkout's node_modules owns the right tsx.
    (cd "$REPO_ROOT" && setsid nohup "$BUN" --expose-internals --import tsx/esm "$CLI_SRC" web --no-open --port "$PORT" >>"$LOG" 2>&1 < /dev/null &)
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

# Pull Mistral Vibe CLI sessions that are newer than the last import into the
# dsh session store (`scripts/import-vibe.mjs --new-only`, never clobbering
# sessions resumed inside dsh). The importer requires the server to be stopped,
# so an already-running server owned by this checkout is stopped first and the
# caller re-probes: the click then follows the cold-start path. A dry run first
# decides whether anything is pending, so clicks with nothing new neither stop
# the server nor pay the import.
maybe_import_vibe() {
  [ "$RUN_MODE" = "source" ] || return 1
  [ -n "$BUN" ] || return 1
  [ -d "$VIBE_STORE" ] || return 1
  if [ -f "$VIBE_IMPORT_STATE" ] \
    && ! find "$VIBE_STORE" -newer "$VIBE_IMPORT_STATE" -print -quit 2>/dev/null | grep -q .; then
    return 1
  fi
  pending=$(cd "$REPO_ROOT" && "$BUN" scripts/import-vibe.mjs --new-only --dry-run 2>/dev/null \
    | grep -o 'importing [0-9]*' | head -1)
  count=${pending#importing }
  case "$count" in ''|*[!0-9]*) return 1;; esac
  [ "$count" -gt 0 ] || return 1
  echo "dsh-helium-pwa: $count new Vibe session(s), importing..." >&2
  if [ "$listener" = "ours" ]; then
    echo "dsh-helium-pwa: stopping the running server for the import" >&2
    kill "$LISTENER_PID" 2>/dev/null
    wait_port_free 10
    if [ -n "$(port_pid)" ]; then
      kill -9 "$LISTENER_PID" 2>/dev/null
      wait_port_free 5
    fi
  fi
  mkdir -p "$(dirname "$VIBE_IMPORT_STATE")" "$(dirname "$LOG")"
  if out=$(cd "$REPO_ROOT" && "$BUN" scripts/import-vibe.mjs --new-only 2>&1); then
    printf '%s\n' "$out" >>"$LOG"
    echo "$out" >&2
    touch "$VIBE_IMPORT_STATE"
  else
    printf '%s\n' "$out" >>"$LOG" 2>/dev/null
    echo "dsh-helium-pwa: vibe import failed; continuing without it" >&2
  fi
}

# Purge a persisted Le Chat service worker registration from the window
# profile while the browser is closed. Once chat.mistral.ai's sw.js controls
# the origin, Chromium routes document loads through the worker, where the
# permit daemon's response interception cannot run, and the pane silently
# dies. The daemon blocks sw.js itself from now on, so this only removes
# residue from before that guard existed; it needs the browser closed, which
# is why it runs here, before exec.
maybe_purge_lechat_sw() {
  [ -d "$PROFILE/Default/Service Worker" ] || return 0
  pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1 && return 0
  rm -rf "$PROFILE/Default/Service Worker" 2>/dev/null \
    && echo "dsh-helium-pwa: purged Le Chat service worker registration" >&2
}

# The in-window Le Chat pane (apps/web/public/lechat-in-app.js) embeds
# chat.mistral.ai in a sandboxed iframe; the engine only accepts the frame
# while scripts/lechat-frame-permit.mjs strips Le Chat's frame-blocking
# headers through the window's DevTools port. Singleton via pidfile, started
# before the window so the very first load is already covered.
maybe_start_lechat_permit() {
  [ "$RUN_MODE" = "source" ] || return 0
  [ -n "$BUN" ] || return 0
  [ -f "$REPO_ROOT/scripts/lechat-frame-permit.mjs" ] || return 0
  if [ -f "$LECHAT_PERMIT.pid" ] && kill -0 "$(cat "$LECHAT_PERMIT.pid" 2>/dev/null)" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$LECHAT_PERMIT.pid")"
  setsid nohup "$BUN" "$REPO_ROOT/scripts/lechat-frame-permit.mjs" \
    --cdp-port "$LECHAT_CDP_PORT" --app-origin "$BASE" \
    >>"$LECHAT_PERMIT.log" 2>&1 < /dev/null &
  echo $! >"$LECHAT_PERMIT.pid"
}

# One probe pass: HTTP status code, listening pid, its cmdline, classification.
probe_all() {
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$BASE" 2>/dev/null); code=${code:-000}; [ -z "$code" ] && code=000
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
}

url="$BASE"

# Who holds the port: our server, a stale dsh from another install, or an
# unrelated listener.
probe_all

# Import new Vibe sessions first (stop→import→start, per the importer's
# contract); re-probe when the import stopped our server.
if maybe_import_vibe && [ "$listener" = "ours" ]; then
  probe_all
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

maybe_purge_lechat_sw
maybe_start_lechat_permit

exec "$HELIUM" --password-store=basic --user-data-dir="$PROFILE" --ozone-platform=x11 --class=deepseek-harness --remote-debugging-port="$LECHAT_CDP_PORT" --app="$url"
