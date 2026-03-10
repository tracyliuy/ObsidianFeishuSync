#!/bin/bash
# 将 Feishu Sync 插件升级到当前版本（你的 fork 最新代码）
# 用法: ./upgrade-obsidian-plugin.sh <你的Obsidian-Vault路径>
# 例如: ./upgrade-obsidian-plugin.sh ~/Documents/MyVault

VAULT_PATH="$1"
if [ -z "$VAULT_PATH" ]; then
  echo "用法: $0 <Obsidian-Vault路径>"
  echo "例如: $0 ~/Documents/MyVault"
  exit 1
fi

VAULT_PATH="${VAULT_PATH/#\~/$HOME}"
PLUGIN_DIR="${VAULT_PATH}/.obsidian/plugins/feishu-sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$VAULT_PATH" ]; then
  echo "错误: Vault 路径不存在: $VAULT_PATH"
  exit 1
fi

mkdir -p "$PLUGIN_DIR"

# 复制插件必要文件
cp "$SCRIPT_DIR/main.js" "$PLUGIN_DIR/"
cp "$SCRIPT_DIR/manifest.json" "$PLUGIN_DIR/"
[ -f "$SCRIPT_DIR/versions.json" ] && cp "$SCRIPT_DIR/versions.json" "$PLUGIN_DIR/"

echo "已升级到: $PLUGIN_DIR"
echo "请重启 Obsidian 或重新加载插件以使更改生效。"
