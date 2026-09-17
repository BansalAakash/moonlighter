#!/bin/bash
# Keeps AutoRetryBar actually alive, not just running.
#
# A menu-bar agent can go stale without ever crashing: a stuck main thread or a Timer
# that stopped firing leaves the process sitting there at 0% CPU, invisible to both
# launchd and a plain `pgrep` — it looks perfectly healthy while quietly showing nothing.
# This checks the heartbeat the app writes on every refresh tick (see Snapshot.writeHeartbeat
# in Model.swift) and force-restarts it if that heartbeat has stopped moving, in addition to
# the plain "it's not running at all" case. Runs every 60s via
# com.moonlighter.autoretrybar.watchdog.plist so it survives sleep/wake, network changes,
# and reboots without depending on macOS's Login Items list.
set -u

APP=/Applications/AutoRetryBar.app
HEARTBEAT="$HOME/.claude-auto-retry/menubar-heartbeat"
STALE_AFTER=90   # 3 missed 5s ticks, same tolerance the app itself uses for a dead monitor

restart() {
    pkill -x AutoRetryBar 2>/dev/null
    sleep 1
    open -a "$APP"
}

if ! pgrep -x AutoRetryBar >/dev/null; then
    open -a "$APP"
    exit 0
fi

if [ ! -f "$HEARTBEAT" ]; then
    # Just (re)launched — give it a chance to write its first heartbeat before judging it.
    exit 0
fi

age=$(( $(date +%s) - $(cat "$HEARTBEAT" 2>/dev/null || echo 0) ))
if [ "$age" -gt "$STALE_AFTER" ]; then
    restart
fi
