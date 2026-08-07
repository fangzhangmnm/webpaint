#!/usr/bin/env bash
# gen-api —— 全仓 API 头文件树（.h ritual，user 2026-08-03 立，家族总 CLAUDE.md 有条目）。
# api/ = tsc 生成的 .d.ts 纯签名树（C 头文件等价物），**供人类参考**：发版 ritual / 重构交付 /
# 大功能落地时重跑；重构策划须附「现状 .h + 提案 .h」。生成物勿手改。
# 字面量联合（"undo"|"redo" 等 typed enum）会自动打印；裸 string 参数视为待进化（开放集除外）。
set -e
cd "$(dirname "$0")/.."
rm -rf api
npx tsc -p tsconfig.json --declaration --emitDeclarationOnly --noEmit false --outDir api
rm -rf api/test   # 测试的 .d.ts 是噪音，只留 src
echo "[gen-api] → api/ ($(find api -name '*.d.ts' | wc -l) 个 .d.ts)"
