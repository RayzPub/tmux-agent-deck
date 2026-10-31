#!/usr/bin/env bash
set -e

echo "🚀 ccnow-agent: Local Edge Agent Installer & Launcher"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Node.js is not installed. Please install Node.js (>= 20) first."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "⚠️ Warning: Node.js >= 20 is strongly recommended for native WebSocket support. Current version: $(node -v)"
fi

SERVER_HOST="${CCNOW_SERVER:-}"
if [ -z "$SERVER_HOST" ]; then
  # Determine current host if possible or prompt
  SERVER_HOST="https://outshine.cloud"
fi

echo "📦 Running ccnow-agent via npx..."
exec npx ccnow-agent "$@"
