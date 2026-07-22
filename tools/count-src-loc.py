#!/usr/bin/env python3
"""0.4 纪元体重秤：数 src/（非 vendor）.ts/.js 的实质代码行。

口径（用户 2026-07-22 钉的）：不算测试套件、注释、文档等杂项——
只数 src/ 下非 vendor 的 .ts/.js，剔除空行、纯注释行（// 与 /* */ 块）。
用法：python3 tools/count-src-loc.py [git-ref=HEAD]
基线：v0.4.0(895fd20)=23280 行 · v0.4.8(94def73)=24658 行。S9 目标 ≤ 23280。
"""
import subprocess, sys

ref = sys.argv[1] if len(sys.argv) > 1 else 'HEAD'
files = subprocess.run(['git', 'ls-tree', '-r', ref, '--name-only'],
                       capture_output=True, text=True, check=True).stdout.split('\n')
files = [f for f in files if f.startswith('src/') and (f.endswith('.ts') or f.endswith('.js'))
         and '/vendor/' not in f]
total = 0
for f in files:
    src = subprocess.run(['git', 'show', f'{ref}:{f}'], capture_output=True, text=True).stdout
    in_block = False
    for line in src.split('\n'):
        s = line.strip()
        if in_block:
            if '*/' not in s:
                continue
            in_block = False
            s = s.split('*/', 1)[1].strip()
            if not s or s.startswith('//'):
                continue
        if not s or s.startswith('//'):
            continue
        if s.startswith('/*'):
            if '*/' in s:
                rest = s.split('*/', 1)[1].strip()
                if not rest or rest.startswith('//'):
                    continue
            else:
                in_block = True
                continue
        total += 1
print(f'{ref}: {total} 实质代码行（{len(files)} 个文件）')
