#!/bin/bash
# tmux-agent-deck 数据恢复脚本 (用于机器迁移)
# 此脚本用于将备份的数据、user_data、workspaces 以及配置文件恢复到当前机器。

set -e

# 获取脚本所在的目录（项目根目录）
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "=================================================="
echo "      tmux-agent-deck 数据恢复工具"
echo "=================================================="
echo "项目根目录: $PROJECT_ROOT"
echo "--------------------------------------------------"

# 检查是否指定了备份文件
if [ -z "$1" ]; then
  echo "使用方法: $0 <备份文件路径.tar.gz> [--overwrite]"
  echo ""
  echo "当前 backups/ 目录下的可用备份:"
  if [ -d "backups" ]; then
    ls -lh backups/*.tar.gz 2>/dev/null || echo "  未在 backups/ 目录下找到备份文件。"
  else
    echo "  未找到 backups/ 目录。"
  fi
  exit 1
fi

BACKUP_FILE="$1"
OVERWRITE=false

if [ "$2" == "--overwrite" ]; then
  OVERWRITE=true
fi

# 验证备份文件是否存在
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ 错误: 未找到备份文件 '$BACKUP_FILE'!"
  exit 1
fi

# 动态获取备份中包含的顶层文件/目录，以便精确检测冲突
echo "正在检查备份文件内容..."
ARCHIVE_CONTENTS=$(tar -tzf "$BACKUP_FILE" | cut -d/ -f1 | sort -u)

CONFLICTS=()
for item in $ARCHIVE_CONTENTS; do
  # 排除空行或当前目录标志 '.'
  if [ -n "$item" ] && [ "$item" != "." ]; then
    if [ -e "$item" ]; then
      CONFLICTS+=("$item")
    fi
  fi
done

if [ ${#CONFLICTS[@]} -ne 0 ] && [ "$OVERWRITE" != "true" ]; then
  echo "⚠️ 警告: 当前目标目录下已存在以下将被覆盖的同名数据或配置文件:"
  for conflict in "${CONFLICTS[@]}"; do
    echo "  - $conflict"
  done
  echo "--------------------------------------------------"
  echo "为了防止数据被意外覆盖，默认情况下脚本不会执行恢复。"
  echo "如果您确认要用备份数据覆盖现有数据，请在命令末尾加上 --overwrite 参数:"
  echo "  $0 \"$BACKUP_FILE\" --overwrite"
  echo "--------------------------------------------------"
  exit 1
fi

if [ "$OVERWRITE" == "true" ] && [ ${#CONFLICTS[@]} -ne 0 ]; then
  echo "⚠️ 已启用覆盖模式，现有数据将被替换。"
  # 在覆盖前，为旧数据创建一个快速备份，防止万一
  PRE_RESTORE_DIR="${PROJECT_ROOT}/backups/pre_restore_backup_$(date +"%Y%m%d_%H%M%S")"
  echo "正在为冲突文件创建临时备份到: ${PRE_RESTORE_DIR} ..."
  mkdir -p "$PRE_RESTORE_DIR"
  for item in "${CONFLICTS[@]}"; do
    if [ -e "$item" ]; then
      # 使用 cp -rp 复制文件/文件夹
      cp -rp "$item" "$PRE_RESTORE_DIR/"
    fi
  done
  echo "临时备份创建完成，如果恢复有误，您可以在该目录找回旧数据。"
  echo "--------------------------------------------------"
fi

echo "正在解压备份文件 '$BACKUP_FILE' 到当前目录..."
# 使用 -xzpf 保持权限
tar -xzpf "$BACKUP_FILE" -C "$PROJECT_ROOT"

echo "--------------------------------------------------"
echo "✅ 数据恢复完成！"
echo "提示: 如果遇到权限问题，请在命令前加 sudo，例如: sudo ./restore_data.sh ..."
echo "提示: 如果服务器正在运行，请重启服务器以使配置生效。"
echo "可以使用以下命令重启:"
echo "  sudo ./restart.sh   或者  ./restart.sh"
echo "=================================================="
