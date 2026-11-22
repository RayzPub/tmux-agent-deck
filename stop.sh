#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR" || exit 1

PID_FILE="server.pid"
SYSTEMD_UNIT="ccnow-server.service"

# Auto-escalate with passwordless sudo when needed to stop root-owned process/systemd unit
if [ "$EUID" -ne 0 ] && [ "${CCNOW_NO_SUDO:-0}" != "1" ]; then
    NEED_SUDO=false
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
        NEED_SUDO=true
    elif [ -f "$PID_FILE" ]; then
        CHECK_PID=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$CHECK_PID" ] && ps -p "$CHECK_PID" >/dev/null 2>&1 && ! kill -0 "$CHECK_PID" 2>/dev/null; then
            NEED_SUDO=true
        fi
    fi
    if [ "$NEED_SUDO" = true ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        exec sudo "$0" "$@"
    fi
fi

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}Stopping CCNOW...${NC}"
echo -e "${BLUE}==================================================${NC}"

STOPPED=false

# 1. Stop isolated systemd unit if running
if [ "$EUID" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
        echo -e "${YELLOW}[*] Stopping systemd unit $SYSTEMD_UNIT...${NC}"
        systemctl stop "$SYSTEMD_UNIT"
        systemctl reset-failed "$SYSTEMD_UNIT" 2>/dev/null || true
        STOPPED=true
        echo -e "${GREEN}[✓] Stopped $SYSTEMD_UNIT successfully.${NC}"
    else
        systemctl reset-failed "$SYSTEMD_UNIT" 2>/dev/null || true
    fi
fi

# 2. Stop PID tracked in server.pid (handles legacy nohup or non-systemd runs)
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${YELLOW}[*] Killing process $PID...${NC}"
        kill "$PID"

        # Wait up to 5 seconds for it to exit
        for i in {1..5}; do
            if ! ps -p "$PID" > /dev/null 2>&1; then
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo -e "${RED}[!] Process did not stop. Force killing (SIGKILL)...${NC}"
            kill -9 "$PID"
        fi

        STOPPED=true
        echo -e "${GREEN}[✓] Stopped successfully.${NC}"
    elif [ "$STOPPED" = false ]; then
        echo -e "${YELLOW}[!] Process ${PID:-unknown} is not running. Cleaning up PID file...${NC}"
    fi
    rm -f "$PID_FILE"
elif [ "$STOPPED" = false ]; then
    echo -e "${RED}[!] No running process found (missing $PID_FILE).${NC}"
fi
