#!/bin/sh
# dsh-helium-lechat — launch Mistral Le Chat (chat.mistral.ai) as a standalone
# Helium app window with its own dedicated browser profile, next to the
# DeepSeek Harness PWA window. Le Chat serves X-Frame-Options: SAMEORIGIN with
# a strict CSP, so it cannot be embedded inside the harness web UI; the
# dedicated window keeps the two one alt-tab apart. The profile keeps the
# Le Chat login, and a second launch focuses the existing window instead of
# spawning another.
#
#   dsh-helium-lechat          open (or focus) the Le Chat app window
#   dsh-helium-lechat install  install the .desktop entry + icon for the user
#
# Environment:
#   LECHAT_URL   chat URL (default https://chat.mistral.ai/)
#   HELIUM_BIN   Helium binary (default: `helium-browser` from PATH)
set -u

URL="${LECHAT_URL:-https://chat.mistral.ai/}"
HELIUM="${HELIUM_BIN:-$(command -v helium-browser || true)}"
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/helium-lechat-pwa"

script="$0"
if resolved=$(readlink -f -- "$0" 2>/dev/null) && [ -n "$resolved" ]; then
  script="$resolved"
fi
here=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)

if [ "${1:-}" = "install" ]; then
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor/512x512/apps"
  mkdir -p "$apps" "$icons" "$HOME/.local/bin"
  cp "$here/../assets/linux/mistral-lechat.desktop" "$apps/mistral-lechat.desktop"
  cp "$here/../assets/linux/mistral-lechat.png" "$icons/mistral-lechat.png"
  ln -sf "$here/helium-lechat.sh" "$HOME/.local/bin/dsh-helium-lechat"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" || true
  echo "installed: $apps/mistral-lechat.desktop (Exec=dsh-helium-lechat) + icon + ~/.local/bin/dsh-helium-lechat"
  exit 0
fi

if [ -z "$HELIUM" ]; then
  echo "dsh-helium-lechat: helium-browser not found on PATH (set HELIUM_BIN)" >&2
  exit 1
fi

exec "$HELIUM" --user-data-dir="$PROFILE" --class=mistral-lechat --app="$URL"
