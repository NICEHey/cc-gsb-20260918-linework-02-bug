#!/bin/sh
# 一键自测：几何/状态模型 + 功能/性能回归（Node）+ 服务器冒烟（Python），均只用标准库。
set -e
cd "$(dirname "$0")"
echo "== 引擎与工作台模型测试 =="
node tests/run_tests.js
echo ""
echo "== 面积/退化输入/性能回归 =="
node tests/regression.js
echo ""
echo "== 服务器冒烟测试 =="
python3 tests/server_smoke.py
