#!/usr/bin/env python3
"""一键：画「代码行数 / 每次 commit」图 + 打 commit 概述到文件。

用法（在 repo 任意子目录里跑都行）：
    python3 tools/loc-history.py                 # 全套：图 + csv + 概述
    python3 tools/loc-history.py --out /tmp/foo  # 换输出目录
    python3 tools/loc-history.py --branch prod   # 换分支/ref（默认当前 HEAD）

产物（默认落 docs/reports/loc/）：
    loc-history.png      —— 上图=累计代码行数曲线，下图=每 commit 增删柱
    loc-history.csv      —— 同数据的表（seq,hash,date,added,deleted,net,total,subject）
    commit-summaries.md  —— 每次 commit 一行短概述

说明：
  - 行数按 `git log --numstat` 累计（快、标准；含改名/二进制会近似，但形状准）。
  - 默认排除 vendor/ dist/ node_modules/ *-lock*（vendored 依赖不算「我写的代码」）。
  - 只读当前 ref 的历史；不碰 .claude/worktrees（那些是 incomplete checkout）。
"""
import subprocess, sys, os, csv, argparse

# 不算进「代码行数」的路径前缀 / 文件（可按需加）
EXCLUDE_PREFIX = ('vendor/', 'dist/', 'node_modules/', '.claude/')
EXCLUDE_SUBSTR = ('package-lock.json', 'esbuild')
# 二进制文件 numstat 出 '-' '-'，本来就会被跳过

def repo_root():
    r = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('不在 git 仓库里：' + r.stderr.strip())
    return r.stdout.strip()

def excluded(path):
    if path.startswith(EXCLUDE_PREFIX):
        return True
    return any(s in path for s in EXCLUDE_SUBSTR)

def collect(ref):
    """返回按时间正序的 commit 记录列表。"""
    SEP = '\x1f'
    fmt = '@@@' + SEP.join(['%H', '%h', '%ad', '%an', '%s'])
    out = subprocess.run(
        ['git', 'log', '--reverse', '--numstat', '--date=short',
         '--pretty=format:' + fmt, ref],
        capture_output=True, text=True, errors='replace')
    if out.returncode != 0:
        sys.exit('git log 失败：' + out.stderr.strip())

    commits, cur, total = [], None, 0
    for line in out.stdout.splitlines():
        if line.startswith('@@@'):
            if cur:
                commits.append(cur)
            h, sh, date, author, subj = (line[3:].split(SEP) + [''] * 4)[:5]
            cur = dict(hash=h, short=sh, date=date, author=author,
                       subject=subj, added=0, deleted=0)
        elif line.strip() and cur is not None:
            parts = line.split('\t')
            if len(parts) < 3:
                continue
            a, d, path = parts[0], parts[1], parts[2]
            if a == '-' or d == '-' or excluded(path):
                continue
            cur['added'] += int(a)
            cur['deleted'] += int(d)
    if cur:
        commits.append(cur)

    for c in commits:
        c['net'] = c['added'] - c['deleted']
        total += c['net']
        c['total'] = total
    return commits

def write_csv(commits, path):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['seq', 'hash', 'date', 'added', 'deleted', 'net', 'total', 'subject'])
        for i, c in enumerate(commits):
            w.writerow([i, c['short'], c['date'], c['added'], c['deleted'],
                        c['net'], c['total'], c['subject']])

def write_summaries(commits, path, width=80):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('# Commit 概述（每行一次）\n\n')
        f.write(f'共 {len(commits)} 次 commit；最新代码行数 ≈ {commits[-1]["total"]}\n\n')
        for i, c in enumerate(commits):
            subj = c['subject']
            if len(subj) > width:
                subj = subj[:width - 1] + '…'
            f.write(f'- `{c["short"]}` {c["date"]} (+{c["added"]}/-{c["deleted"]}) {subj}\n')

def draw(commits, path, zh):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('  (没装 matplotlib，跳过 PNG；csv/md 已生成)')
        return False
    # 有中文字体走中文，没有就退纯 ASCII，绝不留豆腐块
    L = dict(y_total='累计代码行数 (LOC)', y_churn='每 commit 增删',
             x='commit 序号（时间正序）', add='新增', rm='删除',
             title=f'WebPaint 代码行数演进 — {len(commits)} commits，现 ≈ {commits[-1]["total"]} 行') if zh else \
        dict(y_total='cumulative LOC', y_churn='per-commit churn',
             x='commit # (chronological)', add='added', rm='deleted',
             title=f'WebPaint LOC history — {len(commits)} commits, now ~{commits[-1]["total"]} lines')
    xs = list(range(len(commits)))
    total = [c['total'] for c in commits]
    added = [c['added'] for c in commits]
    deleted = [-c['deleted'] for c in commits]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(13, 8), sharex=True,
                                   gridspec_kw={'height_ratios': [2, 1]})
    ax1.fill_between(xs, total, color='#4c78a8', alpha=0.25)
    ax1.plot(xs, total, color='#4c78a8', lw=1.5)
    ax1.set_ylabel(L['y_total'])
    ax1.set_title(L['title'])
    ax1.grid(True, alpha=0.3)

    ax2.bar(xs, added, color='#54a24b', width=1.0, label=L['add'])
    ax2.bar(xs, deleted, color='#e45756', width=1.0, label=L['rm'])
    ax2.axhline(0, color='#888', lw=0.6)
    ax2.set_ylabel(L['y_churn'])
    ax2.set_xlabel(L['x'])
    ax2.legend(loc='upper left', fontsize=9)
    ax2.grid(True, alpha=0.3)

    # x 轴标少量日期刻度
    n = len(commits)
    step = max(1, n // 10)
    ticks = xs[::step]
    ax2.set_xticks(ticks)
    ax2.set_xticklabels([commits[i]['date'] for i in ticks], rotation=45, ha='right')

    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return True

def pick_font():
    """只在装了「自带拉丁+数字的整套中文字体」时用中文标签，否则退英文。
    matplotlib 的逐字体回退在不少环境不可靠，所以不混字体——要么单字体全包，要么纯英文。
    Droid Sans Fallback 这类「只有汉字、没有拉丁/数字」的字体故意排除。"""
    FULL_CJK = ('Noto Sans CJK SC', 'Noto Sans CJK JP', 'Source Han Sans SC',
                'Microsoft YaHei', 'SimHei', 'SimSun', 'WenQuanYi Zen Hei',
                'WenQuanYi Micro Hei', 'Arial Unicode MS', 'PingFang SC')
    try:
        import matplotlib
        from matplotlib import font_manager
        for name in FULL_CJK:
            try:
                font_manager.findfont(name, fallback_to_default=False)
                matplotlib.rcParams['font.sans-serif'] = [name]
                matplotlib.rcParams['axes.unicode_minus'] = False
                return True
            except Exception:
                continue
    except ImportError:
        pass
    return False

def main():
    ap = argparse.ArgumentParser(description='画代码行数/commit 图 + 打 commit 概述')
    ap.add_argument('--branch', default='HEAD', help='ref（默认当前 HEAD）')
    ap.add_argument('--out', default=None, help='输出目录（默认 docs/reports/loc/）')
    ap.add_argument('--width', type=int, default=80, help='概述单行截断宽度')
    args = ap.parse_args()

    root = repo_root()
    out = args.out or os.path.join(root, 'docs', 'reports', 'loc')
    os.makedirs(out, exist_ok=True)

    print(f'读历史：{args.branch} @ {root}')
    commits = collect(args.branch)
    if not commits:
        sys.exit('没读到 commit')

    csv_p = os.path.join(out, 'loc-history.csv')
    md_p = os.path.join(out, 'commit-summaries.md')
    png_p = os.path.join(out, 'loc-history.png')
    write_csv(commits, csv_p)
    write_summaries(commits, md_p, args.width)
    zh = pick_font()
    if not zh:
        print('  (没找到中文字体，图里标签退英文——数据不受影响)')
    drew = draw(commits, png_p, zh)

    print(f'✓ {len(commits)} commits，现 ≈ {commits[-1]["total"]} 行')
    print(f'  表  {csv_p}')
    print(f'  概述 {md_p}')
    if drew:
        print(f'  图  {png_p}')

if __name__ == '__main__':
    main()
