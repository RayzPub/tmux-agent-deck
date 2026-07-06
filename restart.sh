#!/bin/bash

# Colors for cyberpunk output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}🔄 Tmux Agent Deck - Restarting Server 🌟${NC}"
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

# 2. Start the server
if [ -f "$SCRIPT_DIR/start.sh" ]; then
    # Run the start script
    bash "$SCRIPT_DIR/start.sh"
else
    echo -e "${RED}[✗] start.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi
