#!/bin/zsh
set -e

game_dir="${0:A:h}"
cd "$game_dir"

if command -v node >/dev/null 2>&1; then
  exec node server/server.mjs
fi

bundled_node="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ -x "$bundled_node" ]]; then
  exec "$bundled_node" server/server.mjs
fi

echo "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
echo "按任意键关闭窗口。"
read -k 1
