#!/bin/bash

PID_FILE="server.pid"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}Stopping CCNOW...${NC}"
echo -e "${BLUE}==================================================${NC}"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
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
        
        echo -e "${GREEN}[✓] Stopped successfully.${NC}"
    else
        echo -e "${YELLOW}[!] Process $PID is not running. Cleaning up PID file...${NC}"
    fi
    rm -f "$PID_FILE"
else
    echo -e "${RED}[!] No running process found (missing $PID_FILE).${NC}"
fi
