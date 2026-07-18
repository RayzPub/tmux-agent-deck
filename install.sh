#!/bin/bash

# Colors for cyberpunk output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}🌟 Cyberpunk CCNOW - One-Click Installer 🌟${NC}"
echo -e "${BLUE}==================================================${NC}"

# Check sudo
if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO=""
fi

# Detect OS and install system packages
install_packages() {
    echo -e "${BLUE}[*] Installing system dependencies (git, tmux, curl, firejail, build tools)...${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update
        $SUDO apt-get install -y git tmux curl build-essential python3 firejail
    elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf groupinstall -y "Development Tools"
        $SUDO dnf install -y git tmux curl python3 firejail
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum groupinstall -y "Development Tools"
        $SUDO yum install -y git tmux curl python3 firejail
    elif command -v pacman >/dev/null 2>&1; then
        $SUDO pacman -Sy --needed --noconfirm git tmux curl base-devel python firejail
    elif command -v brew >/dev/null 2>&1; then
        brew install git tmux curl
    else
        echo -e "${YELLOW}[!] Warning: Unknown package manager. Please ensure git, tmux, curl, firejail, and build-essential are installed manually.${NC}"
    fi
}

# Run system package install
install_packages

# Locate the target Node and NPM binaries
locate_node_and_npm() {
    # Determine the home directory of the user (even if sudo is used temporarily)
    if [ "$EUID" -ne 0 ]; then
        USER_HOME="$HOME"
    else
        USER_HOME=$(eval echo "~${SUDO_USER:-$USER}")
    fi

    # Load NVM if it exists
    export NVM_DIR="$USER_HOME/.nvm"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        \. "$NVM_DIR/nvm.sh"
    fi

    # 1. Try to find the highest Node version in NVM (prioritized like start.sh)
    NVM_NODE=$(find "$NVM_DIR/versions/node" -maxdepth 3 -type f -name "node" | sort -V | tail -n 1 2>/dev/null)

    if [ -n "$NVM_NODE" ] && [ -x "$NVM_NODE" ]; then
        NODE_BIN="$NVM_NODE"
    elif command -v node >/dev/null 2>&1; then
        NODE_BIN=$(command -v node)
    else
        NODE_BIN=""
        # Try common paths
        for path in /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
            if [ -x "$path" ]; then
                NODE_BIN="$path"
                break
            fi
        done
    fi

    if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
        NPM_BIN="$(dirname "$NODE_BIN")/npm"
        if [ ! -x "$NPM_BIN" ]; then
            NPM_BIN="npm"
        fi
    else
        NPM_BIN="npm"
    fi
}

# Check/Install Node.js
check_node() {
    locate_node_and_npm
    
    if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
        NODE_VER=$("$NODE_BIN" -v | cut -d'v' -f2)
        NODE_MAJOR=$(echo "$NODE_VER" | cut -d'.' -f1)
        if [ "$NODE_MAJOR" -ge 18 ]; then
            echo -e "${GREEN}[✓] Node.js is already installed (v$NODE_VER) at $NODE_BIN${NC}"
            return 0
        fi
    fi

    # Install/Use NVM to install Node.js v20
    if ! command -v nvm >/dev/null 2>&1; then
        echo -e "${BLUE}[*] Node.js >= 18 not found. Installing NVM (Node Version Manager)...${NC}"
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        
        # Reload NVM path
        if [ "$EUID" -ne 0 ]; then
            USER_HOME="$HOME"
        else
            USER_HOME=$(eval echo "~${SUDO_USER:-$USER}")
        fi
        export NVM_DIR="$USER_HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi
    
    if command -v nvm >/dev/null 2>&1; then
        echo -e "${BLUE}[*] Installing Node.js v20 via NVM...${NC}"
        nvm install 20
        nvm use 20
        nvm alias default 20
        locate_node_and_npm
    else
        echo -e "${RED}[✗] Failed to load NVM. Trying package manager to install Node.js...${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
            $SUDO apt-get install -y nodejs
            locate_node_and_npm
        else
            echo -e "${RED}[✗] Could not install Node.js automatically. Please install Node.js >= 18 manually.${NC}"
            exit 1
        fi
    fi
}

check_node

# Load NVM if it was installed
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Clone/Setup Project Directory
if [ -f "package.json" ] && (grep -q '"name": "ccnow"' package.json || grep -q '"name": "tmux-agent-deck"' package.json); then
    echo -e "${GREEN}[*] Detected CCNOW/tmux-agent-deck in the current directory. Proceeding here...${NC}"
else
    echo -e "${BLUE}[*] Cloning tmux-agent-deck repository...${NC}"
    git clone https://github.com/RayzPub/tmux-agent-deck.git
    cd tmux-agent-deck || {
        echo -e "${RED}[✗] Failed to enter project directory 'tmux-agent-deck'.${NC}"
        exit 1
    }
fi

# Ensure .env setup
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo -e "${BLUE}[*] Creating .env from .env.example...${NC}"
        cp .env.example .env
    else
        echo -e "${BLUE}[*] Creating default .env...${NC}"
        echo "PORT=80" > .env
        echo "PASSWORD=tmuxadmin" >> .env
        echo "JWT_SECRET=cyberpunk-tmux-secret-key-1337" >> .env
        echo "DEFAULT_SHELL=/bin/bash" >> .env
    fi
fi

# Install Node dependencies
echo -e "${BLUE}[*] Installing npm dependencies using $NPM_BIN...${NC}"
# Use the node / npm from active path or NVM
"$NPM_BIN" install || {
    echo -e "${YELLOW}[!] Standard install failed. Retrying with --legacy-peer-deps...${NC}"
    "$NPM_BIN" install --legacy-peer-deps
}

# Make shell scripts executable
chmod +x start.sh stop.sh restart.sh bin/deck-notify 2>/dev/null

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}🌟 CCNOW Installation Complete! 🌟${NC}"
echo -e "${BLUE}==================================================${NC}"
echo -e "To configure the server, edit the ${YELLOW}.env${NC} file."
echo -e "To run the server in the background, execute:"
echo -e "  ${GREEN}sudo ./start.sh${NC}"
echo -e ""
echo -e "To stop the server:"
echo -e "  ${GREEN}sudo ./stop.sh${NC}"
echo -e ""
echo -e "To monitor server logs:"
echo -e "  ${GREEN}tail -f server.log${NC}"
echo -e "${BLUE}==================================================${NC}"
