#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 18+：https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/2] 首次运行，安装依赖……"
  npm install --no-audit --no-fund
else
  echo "[1/2] 依赖已存在，跳过安装"
fi

echo "[2/2] 启动开发服务器：http://localhost:3000"
exec npm run dev
