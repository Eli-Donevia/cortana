#!/bin/bash
# Double-click to start Cortana.
# First run installs the packages (a few minutes) and signs you in to Claude.
# Close this window to stop Jarvis.
#
# The optional LaunchAgent (docs/launchagent) runs this same file at login
# with JARVIS_LAUNCH_AGENT=1: no Terminal window, so it never waits for a key
# and never opens the sign-in; it writes to ~/Library/Logs/donevia-jarvis.log.

cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  if [ "$JARVIS_LAUNCH_AGENT" != "1" ] && [ -t 0 ]; then
    echo ""
    read -n 1 -s -r -p "  Press any key to close."
  fi
  exit "${1:-1}"
}

# Finder-launched scripts get a minimal PATH; add the usual Node locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install the LTS version from https://nodejs.org, then double-click this file again."
  pause_and_exit 1
fi

# Too old a Node (Vite needs 20.19+ or 22.12+): say so before downloading anything.
if ! node scripts/node-check.mjs; then
  pause_and_exit 1
fi

# Install (or repair) the packages. A stamp is written only after an install
# finishes, so an interrupted install, or packages copied from another Mac,
# are reinstalled on the next double-click instead of crashing later.
if ! node scripts/stamp.mjs check 2>/dev/null; then
  echo ""
  if [ -d node_modules ]; then
    echo "  Repairing the packages (the last install did not finish, or they are from another Mac)."
  else
    echo "  First run: installing packages. This takes a few minutes."
  fi
  echo ""
  if [ -f package-lock.json ]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
  if [ $? -ne 0 ] || ! node scripts/stamp.mjs write; then
    echo ""
    echo "  The install did not finish. Check the internet connection, then double-click this file again."
    pause_and_exit 1
  fi
fi

# Setup prints the one thing to do, if anything.
node scripts/setup.mjs --launcher
status=$?

# 2 means the only thing missing is the Claude sign-in: do it now (not from
# the LaunchAgent, which has no window to sign in from).
if [ $status -eq 2 ]; then
  if [ "$JARVIS_LAUNCH_AGENT" = "1" ]; then
    echo "  Not signed in to Claude. Double-click \"Start Cortana.command\" once to sign in."
    exit 1
  fi
  node scripts/login.mjs && node scripts/setup.mjs --launcher
  status=$?
  if [ $status -eq 2 ]; then
    echo "  The sign-in did not finish. Double-click \"Start Cortana\" again to try again."
  fi
fi

if [ $status -ne 0 ]; then
  pause_and_exit 1
fi

exec node scripts/start.mjs
