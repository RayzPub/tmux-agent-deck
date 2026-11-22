#!/bin/bash

# Colors for cyberpunk output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR" || exit 1

RESTART_AGENT=false
for arg in "$@"; do
    case "$arg" in
        --with-agent)
            RESTART_AGENT=true
            ;;
    esac
done

# Auto-escalate with passwordless sudo when running as non-root (set CCNOW_NO_SUDO=1 to opt out)
if [ "$EUID" -ne 0 ] && [ "${CCNOW_NO_SUDO:-0}" != "1" ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        exec sudo "$0" "$@"
    fi
fi

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}🔄 CCNOW - Restarting Server 🌟${NC}"
echo -e "${BLUE}==================================================${NC}"

# Check if run as root or with sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}[!] WARNING: Binding to port 443 requires root privileges.${NC}"
    echo -e "${YELLOW}    If the server fails to bind, please run: sudo ./restart.sh${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"
fi

# 1. Stop the server
if [ -f "$SCRIPT_DIR/stop.sh" ]; then
    bash "$SCRIPT_DIR/stop.sh"
else
    echo -e "${RED}[✗] stop.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

# Short sleep to make sure port is fully released
sleep 1.5

# 2. Start the server (automatically isolated into ccnow-server.service cgroup on systemd)
if [ -f "$SCRIPT_DIR/start.sh" ]; then
    bash "$SCRIPT_DIR/start.sh"
    START_EXIT=$?
    if [ "$START_EXIT" -ne 0 ]; then
        exit "$START_EXIT"
    fi
else
    echo -e "${RED}[✗] start.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

# 3. Optionally restart ccnow-host-agent.service when --with-agent is specified
if [ "$RESTART_AGENT" = true ] && [ "$EUID" -eq 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files ccnow-host-agent.service 2>/dev/null | grep -q "ccnow-host-agent.service"; then
        if grep -q "ccnow-host-agent.service" /proc/$$/cgroup 2>/dev/null && command -v systemd-run >/dev/null 2>&1; then
            echo -e "${YELLOW}[*] Scheduling detached restart of ccnow-host-agent.service in 1s...${NC}"
            systemd-run --on-active=1 --unit="ccnow-agent-deferred-restart-$$" --collect \
                /usr/bin/systemctl restart ccnow-host-agent.service >/dev/null 2>&1
        else
            echo -e "${BLUE}[*] Restarting ccnow-host-agent.service...${NC}"
            systemctl restart ccnow-host-agent.service
            echo -e "${GREEN}[✓] ccnow-host-agent.service restarted.${NC}"
        fi
    fi
fi
