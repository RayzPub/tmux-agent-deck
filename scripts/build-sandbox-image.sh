#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

IMAGE_TAG="${DOCKER_SANDBOX_IMAGE:-ccnow-sandbox:latest}"
APT_MIRROR=""
NPM_REGISTRY=""
INSTALL_AGY="true"
INSTALL_KIMI="true"
INSTALL_DSH="false"
NO_CACHE="false"
RECREATE_RUNNING="false"

usage() {
  cat <<'EOF'
Usage: scripts/build-sandbox-image.sh [options]

Options:
  --tag <image:tag>       Docker image tag (default: ccnow-sandbox:latest)
  --apt-mirror <host>     Debian APT mirror host (e.g. mirrors.tencent.com)
  --npm-registry <url>    npm registry URL (default: auto-detect from npm config)
  --no-agy                Skip installing Antigravity CLI (agy)
  --no-kimi               Skip installing Kimi Code CLI (kimi)
  --with-dsh              Also install @deepseek-ai/dsh globally
  --no-cache              Pass --no-cache to docker build
  --recreate-running      Recreate running ccnow-sandbox containers using containerService
  -h, --help              Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      IMAGE_TAG="${2:?--tag requires a value}"
      shift 2
      ;;
    --apt-mirror)
      APT_MIRROR="${2:?--apt-mirror requires a value}"
      shift 2
      ;;
    --npm-registry)
      NPM_REGISTRY="${2:?--npm-registry requires a value}"
      shift 2
      ;;
    --no-agy)
      INSTALL_AGY="false"
      shift
      ;;
    --no-kimi)
      INSTALL_KIMI="false"
      shift
      ;;
    --with-dsh)
      INSTALL_DSH="true"
      shift
      ;;
    --no-cache)
      NO_CACHE="true"
      shift
      ;;
    --recreate-running)
      RECREATE_RUNNING="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Locate node binary (supports nvm when invoked under sudo)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  SUDO_HOME="$(eval echo "~${SUDO_USER}")"
  NODE_BIN="$(find "${SUDO_HOME}/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "${NODE_BIN}" ]; then
  NODE_BIN="$(find "${HOME}/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "${NODE_BIN}" ]; then
  echo "Error: node binary not found in PATH or ~/.nvm" >&2
  exit 1
fi

# Auto-detect npm registry unless explicitly overridden
if [ -z "${NPM_REGISTRY}" ]; then
  if command -v npm >/dev/null 2>&1; then
    NPM_REGISTRY="$(npm config get registry 2>/dev/null || true)"
  elif [ -x "$(dirname "${NODE_BIN}")/npm" ]; then
    NPM_REGISTRY="$("$(dirname "${NODE_BIN}")/npm" config get registry 2>/dev/null || true)"
  fi
  if [ -z "${NPM_REGISTRY}" ] || [ "${NPM_REGISTRY}" = "undefined" ]; then
    NPM_REGISTRY="https://registry.npmjs.org/"
  fi
fi

# Determine docker invocation (direct vs passwordless sudo)
DOCKER_CMD=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo -n docker)
  elif [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    DOCKER_CMD=(sudo docker)
  else
    echo "Error: Cannot connect to Docker daemon." >&2
    exit 1
  fi
fi

echo "==> [1/4] Updating client/ccnow-agent.js bundle..."
"${NODE_BIN}" bin/build.js

echo "==> [2/4] Building Docker sandbox image '${IMAGE_TAG}'..."
echo "    NPM_REGISTRY=${NPM_REGISTRY}"
echo "    APT_MIRROR=${APT_MIRROR:-default}"
echo "    INSTALL_AGY=${INSTALL_AGY} | INSTALL_KIMI=${INSTALL_KIMI} | INSTALL_DSH=${INSTALL_DSH}"

BUILD_ARGS=(
  build
  -f docker/Dockerfile.sandbox
  -t "${IMAGE_TAG}"
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY}"
  --build-arg "INSTALL_AGY=${INSTALL_AGY}"
  --build-arg "INSTALL_KIMI=${INSTALL_KIMI}"
  --build-arg "INSTALL_DSH=${INSTALL_DSH}"
)
if [ -n "${APT_MIRROR}" ]; then
  BUILD_ARGS+=(--build-arg "APT_MIRROR=${APT_MIRROR}")
fi
if [ "${NO_CACHE}" = "true" ]; then
  BUILD_ARGS+=(--no-cache)
fi
BUILD_ARGS+=(.)

"${DOCKER_CMD[@]}" "${BUILD_ARGS[@]}"

echo "==> [3/4] Verifying image '${IMAGE_TAG}' under hardened sandbox constraints..."
IMAGE_SIZE="$("${DOCKER_CMD[@]}" image inspect --format '{{.Size}}' "${IMAGE_TAG}" | awk '{printf "%.1f MB", $1/1024/1024}')"
echo "    Image size: ${IMAGE_SIZE}"

"${DOCKER_CMD[@]}" run --rm \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --memory=1g \
  --cpus=1 \
  --pids-limit=256 \
  "${IMAGE_TAG}" \
  sh -c '
    echo "node:    $(node -v)"
    echo "pnpm:    $(pnpm -v)"
    echo "tmux:    $(tmux -V)"
    echo "git:     $(git --version)"
    echo "python3: $(python3 --version)"
    echo "rg:      $(rg --version | head -n 1)"
    echo "fd:      $(fd --version)"
    echo "claude:  $(claude --version)"
    echo "codex:   $(codex --version)"
    if command -v agy >/dev/null 2>&1; then echo "agy:     $(agy --version)"; fi
    if command -v kimi >/dev/null 2>&1; then echo "kimi:    $(kimi --version)"; fi
    node -e "require(\"/opt/ccnow/node_modules/node-pty\"); console.log(\"node-pty: OK\")"
    node --input-type=module -e "import(\"/opt/ccnow/node_modules/@botiverse/oar/dist/index.js\").then(() => console.log(\"oar:      OK\"))"
  '

echo "==> [4/4] Checking running managed sandboxes..."
RUNNING_USERS="$("${DOCKER_CMD[@]}" ps --filter "label=ccnow.managed=true" --format '{{.Label "ccnow.user"}}' || true)"

if [ "${RECREATE_RUNNING}" = "true" ] && [ -n "${RUNNING_USERS}" ]; then
  for u in ${RUNNING_USERS}; do
    echo "    Recreating running sandbox for user '${u}'..."
    "${NODE_BIN}" -e '
      const cs = require("./services/containerService");
      cs.ensureUserSandbox(process.argv[1], { recreate: true })
        .then((res) => { console.log("    ->", JSON.stringify(res)); process.exit(0); })
        .catch((err) => { console.error("    -> ERROR:", err.message); process.exit(1); });
    ' "${u}"
  done
elif [ -n "${RUNNING_USERS}" ]; then
  echo "    Running sandbox containers still on previous container instance:"
  for u in ${RUNNING_USERS}; do
    echo "      - ccnow-sandbox-${u}"
  done
  echo "    Re-run with --recreate-running (or stop/restart via UI) to upgrade them to '${IMAGE_TAG}'."
else
  echo "    No running managed sandbox containers to upgrade."
fi

echo "==> Done! Sandbox image '${IMAGE_TAG}' is ready."
