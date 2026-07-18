#!/bin/bash
# tmux-agent-deck 数据导出脚本 (用于机器迁移)
# 此脚本会自动打包用户账号体系数据、系统配置文件，并对 admin 账号进行脱敏。

set -e

# 获取脚本所在的目录（项目根目录）
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

BACKUP_DIR="${PROJECT_ROOT}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

EXPORT_ALL=false
if [ "$1" == "--all" ]; then
  EXPORT_ALL=true
fi

if [ "$EXPORT_ALL" == "true" ]; then
  BACKUP_NAME="tmux_agent_deck_backup_all_${TIMESTAMP}.tar.gz"
else
  BACKUP_NAME="tmux_agent_deck_backup_accounts_${TIMESTAMP}.tar.gz"
fi
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

echo "=================================================="
echo "      tmux-agent-deck 数据导出工具"
echo "=================================================="
echo "项目根目录: $PROJECT_ROOT"
echo "备份文件路径: $BACKUP_PATH"
if [ "$EXPORT_ALL" == "true" ]; then
  echo "备份模式: 完整备份 (核心数据 + 配置文件 + 用户工作区 + 用户缓存)"
else
  echo "备份模式: 账号体系及配置备份 (仅导出账号数据及配置文件，不含工作区 and 缓存)"
fi
echo "--------------------------------------------------"

# 定位 Node.js 可执行文件路径
NODE_EXE="node"
if ! command -v node >/dev/null 2>&1; then
  # 优先尝试项目规定的 NVM 路径
  if [ -f "/home/ubuntu/.nvm/versions/node/v26.4.0/bin/node" ]; then
    NODE_EXE="/home/ubuntu/.nvm/versions/node/v26.4.0/bin/node"
  elif [ -f "$HOME/.nvm/versions/node/v26.4.0/bin/node" ]; then
    NODE_EXE="$HOME/.nvm/versions/node/v26.4.0/bin/node"
  else
    # 模糊查找 NVM 下的 node
    NVM_NODE=$(find "$HOME/.nvm" -type f -name "node" | head -n 1 2>/dev/null)
    if [ -n "$NVM_NODE" ]; then
      NODE_EXE="$NVM_NODE"
    fi
  fi
fi

# 必须导出的核心账号数据目录
REQUIRED_ITEMS=(
  "data"
)

# 可选的配置文件/证书等（如果存在则打包）
OPTIONAL_CONFIGS=(
  ".env"
  "workspaces.json"
  "vapid.json"
  "push_subscriptions.json"
  "im_bindings.json"
  "outshine.cloud.key"
  "outshine.cloud_bundle.pem"
)

# 检查核心目录是否存在
MISSING_REQUIRED=0
for item in "${REQUIRED_ITEMS[@]}"; do
  if [ ! -d "$item" ] && [ ! -f "$item" ]; then
    echo "❌ 错误: 未找到核心目录或文件 '$item'!"
    MISSING_REQUIRED=1
  fi
done

if [ "$MISSING_REQUIRED" -ne 0 ]; then
  echo "由于缺少核心账号目录，导出程序终止。"
  exit 1
fi

# 创建临时分发(Staging)目录，用于脱敏和收集文件
STAGING_DIR="${BACKUP_DIR}/staging_${TIMESTAMP}"
mkdir -p "$STAGING_DIR"

echo "正在收集备份文件..."
for item in "${REQUIRED_ITEMS[@]}"; do
  if [ -e "$item" ]; then
    cp -rp "$item" "$STAGING_DIR/"
  fi
done

# 如果指定了 --all，则加入大文件夹
if [ "$EXPORT_ALL" == "true" ]; then
  LARGE_ITEMS=("user_data" "workspaces")
  for item in "${LARGE_ITEMS[@]}"; do
    if [ -d "$item" ]; then
      cp -rp "$item" "$STAGING_DIR/"
    fi
  done
fi

for item in "${OPTIONAL_CONFIGS[@]}"; do
  if [ -e "$item" ]; then
    cp -rp "$item" "$STAGING_DIR/"
  fi
done

# 自动扫描并复制证书文件
for f in *.key *.pem *.crt *.pfx; do
  if [ -f "$f" ]; then
    cp -rp "$f" "$STAGING_DIR/"
  fi
done

# === 脱敏处理：从备份中移除 admin 账号密码和工作区定义 ===
USERS_JSON="${STAGING_DIR}/data/users.json"
if [ -f "$USERS_JSON" ]; then
  echo "正在对备份的账号数据进行脱敏 (移除 admin 账号信息)..."
  "$NODE_EXE" -e '
    const fs = require("fs");
    const file = process.argv[1];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.admin) {
        delete data.admin;
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
        console.log("  [脱敏] 已成功在备份中移除 admin 的账号及密码 Hash。");
      } else {
        console.log("  [脱敏] 未在备份中发现 admin 账号。");
      }
    } catch (e) {
      console.error("  [警告] 脱敏过滤失败: " + e.message);
    }
  ' "$USERS_JSON"
fi

# 移除 admin 的工作区配置文件
if [ -f "${STAGING_DIR}/data/workspaces_admin.json" ]; then
  rm -f "${STAGING_DIR}/data/workspaces_admin.json"
  echo "  [脱敏] 已在备份中移除 workspaces_admin.json"
fi

echo "--------------------------------------------------"
echo "正在打包数据到 ${BACKUP_NAME}..."

# 进入 staging 目录进行相对路径打包，避免包含 staging 路径前缀，且不生成 ./ 根前缀
cd "$STAGING_DIR"
tar -czpf "$BACKUP_PATH" $(ls -A)

# 回到项目根目录
cd "$PROJECT_ROOT"

# 清理 staging 目录
rm -rf "$STAGING_DIR"

echo "✅ 数据打包及脱敏成功！"
echo "--------------------------------------------------"
echo "备份文件信息:"
ls -lh "$BACKUP_PATH"
echo "MD5 校验码:"
if command -v md5sum >/dev/null 2>&1; then
  md5sum "$BACKUP_PATH"
elif command -v md5 >/dev/null 2>&1; then
  md5 "$BACKUP_PATH"
else
  echo "未找到 md5sum 工具"
fi
echo "=================================================="
if [ "$EXPORT_ALL" != "true" ]; then
  echo "💡 提示: 当前仅备份了账号和配置。若后续需要包含 workspaces 和 user_data，请运行:"
  echo "   ./export_data.sh --all"
  echo "--------------------------------------------------"
fi
echo "提示: 如果遇到权限问题，请在命令前加 sudo，例如: sudo ./export_data.sh"
echo "--------------------------------------------------"
echo "迁移指南 (Migration Guide):"
echo "1. 将备份文件传输到新机器的相应目录下，例如:"
echo "   scp backups/${BACKUP_NAME} user@new-machine:/path/to/tmux-agent-deck/backups/"
echo "2. 在新机器上，运行 restore_data.sh 脚本或手动解压:"
echo "   tar -xzpf backups/${BACKUP_NAME} -C /path/to/tmux-agent-deck/"
echo "=================================================="
