#!/bin/sh
# 一键自测：几何/状态模型（Node）+ 服务器冒烟（Python），均只用标准库。
set -e
cd "$(dirname "$0")"
echo "== 引擎与工作台模型测试 =="
node tests/run_tests.js
echo ""
echo "== 退化/密集输入性能回归 =="
node tests/perf.js
echo ""
echo "== 差分模糊（朴素参考实现，含共线/重复/T 接/禁用段）=="
node tests/diff_fuzz.js
echo ""
echo "== 服务器冒烟测试 =="
python3 tests/server_smoke.py
