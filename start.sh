#!/bin/bash

# Configuration
ENV_FILE=".env"
PORT=80
LOG_FILE="server.log"
PID_FILE="server.pid"

# Colors for cyberpunk output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}🌟 CCNOW - Background Control Script 🌟${NC}"
echo -e "${BLUE}==================================================${NC}"

# 1. Environment & Dependency Checks
MISSING_DEPS=false

# 1.1 Check tmux
if ! command -v tmux >/dev/null 2>&1; then
    echo -e "${RED}[✗] 错误: 系统未安装 tmux！${NC}"
    echo -e "${YELLOW}tmux 是运行 Terminal 会话所必需的的工具。${NC}"
    echo -e "请使用以下命令进行安装："
    echo -e "  - Ubuntu/Debian:    ${GREEN}sudo apt update && sudo apt install -y tmux${NC}"
    echo -e "  - CentOS/Fedora:    ${GREEN}sudo dnf install -y tmux${NC}"
    echo -e "  - macOS:            ${GREEN}brew install tmux${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"
    MISSING_DEPS=true
fi

# 1.2 Check Node.js
if [ "$EUID" -ne 0 ]; then
    USER_HOME="$HOME"
else
    USER_HOME=$(eval echo "~${SUDO_USER:-$USER}")
fi

NVM_NODE=$(find "$USER_HOME/.nvm/versions/node" -maxdepth 3 -type f -name "node" | sort -V | tail -n 1 2>/dev/null)

if [ -n "$NVM_NODE" ] && [ -x "$NVM_NODE" ]; then
    NODE_BIN="$NVM_NODE"
elif command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
else
    NODE_BIN="node"
    # Try common paths
    for path in /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
        if [ -x "$path" ]; then
            NODE_BIN="$path"
            break
        fi
    done
fi

NODE_EXISTS=false
if command -v "$NODE_BIN" >/dev/null 2>&1 || [ -x "$NODE_BIN" ]; then
    NODE_EXISTS=true
fi

if [ "$NODE_EXISTS" = false ]; then
    echo -e "${RED}[✗] 错误: 系统未检测到 Node.js 环境！${NC}"
    echo -e "${YELLOW}Node.js 环境是运行后端服务器所必需的 (推荐 v18+)。${NC}"
    echo -e "请使用以下方式之一安装 Node.js："
    echo -e "  - 方案 A (使用 NVM 安装，推荐):"
    echo -e "    ${GREEN}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash${NC}"
    echo -e "    (重新打开终端或加载环境变量后，运行: ${GREEN}nvm install 18${NC})"
    echo -e "  - 方案 B (Ubuntu/Debian 使用 NodeSource 源):"
    echo -e "    ${GREEN}curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs${NC}"
    echo -e "  - 方案 C (Ubuntu/Debian 官方源):"
    echo -e "    ${GREEN}sudo apt update && sudo apt install -y nodejs npm${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"
    MISSING_DEPS=true
else
    # 1.3 Check npm dependencies
    # Check if node_modules exists, and if we can import key dependencies
    if [ ! -d "node_modules" ] || ! "$NODE_BIN" -e "require('express'); require('socket.io'); require('node-pty')" >/dev/null 2>&1; then
        echo -e "${RED}[✗] 错误: npm 依赖项未安装或不完整！${NC}"
        echo -e "${YELLOW}系统未检测到完整的依赖包 (express, socket.io, node-pty 等)。${NC}"
        echo -e "请执行一键安装脚本来配置并安装依赖："
        echo -e "    ${GREEN}./install.sh${NC}"
        echo -e "${BLUE}--------------------------------------------------${NC}"
        MISSING_DEPS=true
    fi
fi

# Pause and exit if dependencies are missing
if [ "$MISSING_DEPS" = true ]; then
    echo -e "${YELLOW}[!] 检测到环境依赖缺失，请安装上述缺失依赖后再重新启动。${NC}"
    echo -e "${BLUE}==================================================${NC}"
    read -n 1 -s -r -p "按任意键退出..."
    echo ""
    exit 1
fi

# 2. Ensure .env exists
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}[!] .env file not found. Creating a default one...${NC}"
    echo "PORT=$PORT" > "$ENV_FILE"
    echo "PASSWORD=tmuxadmin" >> "$ENV_FILE"
    echo "JWT_SECRET=cyberpunk-tmux-secret-key-1337" >> "$ENV_FILE"
    echo "DEFAULT_SHELL=/bin/bash" >> "$ENV_FILE"
fi

# Function to generate a random hex string
generate_random_hex() {
    # Try openssl first, fallback to /dev/urandom
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        head -c "$1" /dev/urandom 2>/dev/null | xxd -p 2>/dev/null | tr -d '\n'
        # if xxd is missing, fallback to tr
        if [ $? -ne 0 ] || [ -z "$NEW_PWD" ]; then
             tr -dc 'a-zA-Z0-9' < /dev/urandom 2>/dev/null | head -c "$(( $1 * 2 ))"
        fi
    fi
}

# 2. Check and fix PASSWORD
# Read PASSWORD from .env (handle simple PASSWORD=value format)
CURRENT_PWD=$(grep -E "^PASSWORD=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")

if [ -z "$CURRENT_PWD" ] || [ "$CURRENT_PWD" = "tmuxadmin" ] || [ ${#CURRENT_PWD} -lt 16 ]; then
    NEW_PWD=$(generate_random_hex 12)
    if [ -z "$NEW_PWD" ]; then
        # Safe fallback if urandom/openssl read fails
        NEW_PWD="CyberpunkSecurePass$(date +%s)"
    fi
    echo -e "${YELLOW}[!] Weak or missing PASSWORD detected in .env.${NC}"
    echo -e "${GREEN}[+] Generating a strong password for you: ${NEW_PWD}${NC}"
    # Replace line or append
    if grep -q "^PASSWORD=" "$ENV_FILE"; then
        # Use sed to replace.
        sed -i "s|^PASSWORD=.*|PASSWORD=${NEW_PWD}|" "$ENV_FILE"
    else
        echo "PASSWORD=${NEW_PWD}" >> "$ENV_FILE"
    fi
    CURRENT_PWD="$NEW_PWD"
fi

# 3. Check and fix JWT_SECRET
CURRENT_JWT=$(grep -E "^JWT_SECRET=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")

if [ -z "$CURRENT_JWT" ] || [ "$CURRENT_JWT" = "cyberpunk-tmux-secret-key-1337" ] || [ ${#CURRENT_JWT} -lt 32 ]; then
    NEW_JWT=$(generate_random_hex 32)
    if [ -z "$NEW_JWT" ]; then
        # Safe fallback
        NEW_JWT="CyberpunkSecureSecretKey$(date +%s)GenerateLonger"
    fi
    echo -e "${YELLOW}[!] Weak or missing JWT_SECRET detected in .env.${NC}"
    echo -e "${GREEN}[+] Generating a strong random JWT_SECRET...${NC}"
    if grep -q "^JWT_SECRET=" "$ENV_FILE"; then
        sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${NEW_JWT}|" "$ENV_FILE"
    else
        echo "JWT_SECRET=${NEW_JWT}" >> "$ENV_FILE"
    fi
fi

# 4. Locate node binary (already done and verified in step 1)

echo -e "${BLUE}[*] Using Node binary: ${NODE_BIN}${NC}"

# 5. Check if process is already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${RED}[!] Server is already running with PID $PID.${NC}"
        echo -e "${YELLOW}Please stop it first using: ./stop.sh${NC}"
        exit 1
    else
        # Stale PID file
        rm -f "$PID_FILE"
    fi
fi

# 6. Check and build static assets
echo -e "${BLUE}[*] Checking static assets...${NC}"
"$NODE_BIN" bin/build.js

# 7. Start server in the background
echo -e "${GREEN}[*] Starting CCNOW in the background...${NC}"
nohup "$NODE_BIN" server.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!

# Wait a brief moment to see if it immediately crashes
sleep 1.5
if ps -p "$NEW_PID" > /dev/null 2>&1; then
    echo "$NEW_PID" > "$PID_FILE"
    echo -e "${GREEN}[✓] Started successfully! PID: $NEW_PID${NC}"
    echo -e "${GREEN}[✓] Log file: $LOG_FILE${NC}"
    
    # Read ports and SSL configuration from env
    FINAL_PORT=$(grep -E "^PORT=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
    if [ -z "$FINAL_PORT" ]; then
        FINAL_PORT=3000
    fi
    
    HTTPS_PORT=$(grep -E "^HTTPS_PORT=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
    if [ -z "$HTTPS_PORT" ]; then
        HTTPS_PORT=443
    fi
    
    DOMAIN_NAME=$(grep -E "^DOMAIN_NAME=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
    if [ -z "$DOMAIN_NAME" ]; then
        DOMAIN_NAME="localhost"
    fi
    
    SSL_CERT=$(grep -E "^SSL_CERT_PATH=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
    SSL_KEY=$(grep -E "^SSL_KEY_PATH=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
    
    USE_HTTPS=false
    if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ] && [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
        USE_HTTPS=true
    fi
    
    echo -e "${BLUE}--------------------------------------------------${NC}"
    if [ "$USE_HTTPS" = true ]; then
        if [ "$HTTPS_PORT" = "443" ]; then
            echo -e "🔗 URL:      ${GREEN}https://${DOMAIN_NAME}${NC}"
        else
            echo -e "🔗 URL:      ${GREEN}https://${DOMAIN_NAME}:${HTTPS_PORT}${NC}"
        fi
    else
        if [ "$FINAL_PORT" = "80" ]; then
            echo -e "🔗 URL:      ${GREEN}http://${DOMAIN_NAME}${NC}"
        else
            echo -e "🔗 URL:      ${GREEN}http://${DOMAIN_NAME}:${FINAL_PORT}${NC}"
        fi
    fi
    echo -e "🔑 Password: ${GREEN}${CURRENT_PWD}${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"
    echo -e "To stop the server, run: ${YELLOW}./stop.sh${NC}"
else
    echo -e "${RED}[✗] Failed to start. Check $LOG_FILE for details:${NC}"
    cat "$LOG_FILE" | tail -n 20
    exit 1
fi
