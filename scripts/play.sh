#!/usr/bin/env bash
# One-shot game launcher for Windows (run from Git Bash).
#
#   bash scripts/play.sh
#
# It closes any open PowerShell windows, clones the repo if it isn't on disk
# yet (otherwise pulls the latest changes), starts the dev server, and opens
# the game in your browser once the server is up.
#
# WARNING: this kills every PowerShell process, including the one that
# launched your terminal if you started Git Bash from PowerShell. Run it
# from a standalone Git Bash window.

set -euo pipefail

REPO_URL="https://github.com/RKPShaw/Elemental_Territus.git"
GAME_DIR="/c/Users/ryank/projects/Elemental_Territus"
PORT=5173
URL="http://localhost:${PORT}"

# --- 1. Close PowerShell ----------------------------------------------------
# Double slashes stop Git Bash from rewriting /F and /IM as paths.
taskkill.exe //F //IM powershell.exe //T 2>/dev/null || true
taskkill.exe //F //IM pwsh.exe //T 2>/dev/null || true

# --- 2. Clone the repo (or update it if it's already there) -----------------
if [ ! -d "${GAME_DIR}/.git" ]; then
  echo "Cloning ${REPO_URL} into ${GAME_DIR}..."
  git clone "${REPO_URL}" "${GAME_DIR}"
else
  echo "Repo already present; pulling latest changes..."
  git -C "${GAME_DIR}" pull --ff-only || echo "Pull failed (offline or local changes); playing the version already on disk."
fi

cd "${GAME_DIR}"

# --- 3. Install dependencies on first run -----------------------------------
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

# --- 4. Open the browser once the server answers ----------------------------
open_url() {
  if command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe //c start "" "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1"
  elif command -v open >/dev/null 2>&1; then
    open "$1"
  else
    echo "Open $1 in your browser."
  fi
}

(
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null "${URL}"; then
      open_url "${URL}"
      exit 0
    fi
    sleep 1
  done
  echo "Dev server didn't come up within 2 minutes; open ${URL} manually once it's ready."
) &

# --- 5. Run the game --------------------------------------------------------
echo "Starting the game at ${URL} (Ctrl+C to stop)..."
exec npm run dev
