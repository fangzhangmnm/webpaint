#!/usr/bin/env python3
"""一键：画「代码行数 / 每次 commit」图 + 打 commit 概述 + 一组自省 benchmark。

用法（在 repo 任意子目录里跑都行）：
    python3 tools/loc-history.py                 # 全套：图 + csv + 概述 + benchmark
    python3 tools/loc-history.py --out /tmp/foo  # 换输出目录
    python3 tools/loc-history.py --branch prod   # 换分支/ref（默认当前 HEAD）
    python3 tools/loc-history.py --no-lizard     # 跳过静态复杂度（不装 lizard 也能跑）

产物（默认落 docs/reports/loc/）：
    loc-history.png      —— 上图=累计代码行数曲线，下图=每 commit 增删柱
    loc-history.csv      —— 同数据的表（seq,hash,date,added,deleted,net,total,subject）
    commit-summaries.md  —— 每次 commit 一行短概述
    benchmark.md         —— 自省记分卡（总览 + 逐月表）
    benchmark.png        —— 逐月「变更熵 + 返工率」图（season-over-season 用）

benchmark 里都是「越大越乱 / 越大越费」的标量，比 LOC 更能反映手感（尤其 AI 协作）：
  · 变更熵 Hassan–Holt（0–1，归一化）：一段时间里改动摊在多少文件上、多分散。越高越散。
  · 返工率 = 删除行 / 新增行：写完又删/改了多少。越高说明反复越多（AI 时代的关键信号）。
  · 净留存 = 净增 / 毛改动：写下的东西留住了几成。
  · 节奏：commit 数、平均每 commit 毛改动。
  · 静态复杂度（需 lizard，dev 工具不必 vendor）：函数数、平均/最大圈复杂度、复杂度热点数。

说明：
  - 行数按 `git log --numstat` 累计（快、标准；含改名/二进制会近似，但形状准）。
  - 默认排除 vendor/ dist/ node_modules/ *-lock*（vendored 依赖不算「我写的代码」）。
  - 只读当前 ref 的历史；不碰 .claude/worktrees（那些是 incomplete checkout）。
  - 静态复杂度只扫当前 tree 的 src/*.ts（要装 lizard：`pip install lizard`；缺了自动跳过）。
"""
import subprocess, sys, os, csv, argparse, math, glob
from collections import defaultdict

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
                       subject=subj, added=0, deleted=0, files={})
        elif line.strip() and cur is not None:
            parts = line.split('\t')
            if len(parts) < 3:
                continue
            a, d, path = parts[0], parts[1], parts[2]
            if a == '-' or d == '-' or excluded(path):
                continue
            a, d = int(a), int(d)
            cur['added'] += a
            cur['deleted'] += d
            cur['files'][path] = cur['files'].get(path, 0) + a + d
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

# ---------------------------------------------------------------- benchmark ---

def change_entropy(file_weights):
    """Hassan–Holt 变更熵，归一化到 0–1。
    file_weights: {path: 该文件被改的行数}。摊得越均匀/越散 → 越接近 1。"""
    tot = sum(file_weights.values())
    n = len(file_weights)
    if tot <= 0 or n <= 1:
        return 0.0
    h = -sum((w / tot) * math.log2(w / tot) for w in file_weights.values() if w > 0)
    return h / math.log2(n)   # 除以最大熵 log2(n)

def bench_bucket(commits):
    """把一批 commit 聚成一个记分卡（总览或某个月都用这个）。"""
    added = sum(c['added'] for c in commits)
    deleted = sum(c['deleted'] for c in commits)
    gross = added + deleted
    net = added - deleted
    fw = defaultdict(int)
    for c in commits:
        for p, w in c['files'].items():
            fw[p] += w
    return dict(
        commits=len(commits), added=added, deleted=deleted, gross=gross, net=net,
        rework=(deleted / added) if added else 0.0,            # 返工率
        retention=(net / gross) if gross else 0.0,             # 净留存
        entropy=change_entropy(fw),                            # 变更熵 0–1
        touched=len(fw),                                       # 改过的文件数
        per_commit=(gross / len(commits)) if commits else 0.0, # 每 commit 毛改动
    )

def bench_by_month(commits):
    months = defaultdict(list)
    for c in commits:
        months[c['date'][:7]].append(c)   # YYYY-MM
    return [(m, bench_bucket(months[m])) for m in sorted(months)]

def static_metrics(root, use_lizard):
    """当前 tree 的静态复杂度标量（需 lizard）。缺了返回 None。"""
    if not use_lizard:
        return None
    try:
        import lizard
    except ImportError:
        return None
    files = glob.glob(os.path.join(root, 'src', '**', '*.ts'), recursive=True)
    files = [f for f in files if not excluded(os.path.relpath(f, root).replace(os.sep, '/'))]
    ccn, lengths, nloc_tot, hotspots, long_fns, n = [], [], 0, 0, 0, 0
    for f in files:
        try:
            info = lizard.analyze_file(f)
        except Exception:
            continue
        nloc_tot += info.nloc
        for fn in info.function_list:
            n += 1
            ccn.append(fn.cyclomatic_complexity)
            lengths.append(fn.length)
            if fn.cyclomatic_complexity > 10:
                hotspots += 1
            if fn.length > 60:
                long_fns += 1
    if not n:
        return None
    return dict(
        files=len(files), functions=n, nloc=nloc_tot,
        ccn_mean=sum(ccn) / n, ccn_max=max(ccn),
        len_mean=sum(lengths) / n, len_max=max(lengths),
        hotspots=hotspots, long_fns=long_fns,
    )

def write_benchmark(overall, by_month, static, path):
    def f(x, d=2):
        return f'{x:.{d}f}'
    with open(path, 'w', encoding='utf-8') as o:
        o.write('# 自省 benchmark 记分卡\n\n')
        o.write('> 都是「越大越乱 / 越大越费」的标量，比 LOC 更贴手感。归一化过，'
                'season-over-season 可直接比。\n\n')

        o.write('## 总览（全历史）\n\n')
        o.write(f"- 代码量：**{overall['net']}** 行净增（毛改动 {overall['gross']}，"
                f"{overall['commits']} commits，触及 {overall['touched']} 个文件）\n")
        o.write(f"- 返工率（删/增）：**{f(overall['rework'])}** —— 越高说明写完又删/改得越多\n")
        o.write(f"- 净留存（净/毛）：**{f(overall['retention'])}** —— 写下的东西留住了几成\n")
        o.write(f"- 变更熵 Hassan–Holt：**{f(overall['entropy'])}** / 1 —— 改动摊得多散\n")
        o.write(f"- 每 commit 毛改动：**{f(overall['per_commit'], 0)}** 行\n\n")

        if static:
            o.write('## 静态复杂度（当前 tree · src/*.ts · lizard）\n\n')
            o.write(f"- 函数 **{static['functions']}** 个（{static['files']} 文件，"
                    f"{static['nloc']} NLOC）\n")
            o.write(f"- 圈复杂度：平均 **{f(static['ccn_mean'])}**，最大 **{static['ccn_max']}**\n")
            o.write(f"- 函数长度：平均 **{f(static['len_mean'], 0)}** 行，最大 **{static['len_max']}**\n")
            o.write(f"- 复杂度热点（CCN>10）：**{static['hotspots']}** 个；"
                    f"超长函数（>60 行）：**{static['long_fns']}** 个\n\n")
        else:
            o.write('## 静态复杂度\n\n> 没装 lizard，跳过。`pip install lizard` 后重跑即出。\n\n')

        o.write('## 逐月（season-over-season）\n\n')
        o.write('| 月份 | commits | 净增 | 毛改动 | 返工率 | 净留存 | 变更熵 | 每commit |\n')
        o.write('|---|--:|--:|--:|--:|--:|--:|--:|\n')
        for m, b in by_month:
            o.write(f"| {m} | {b['commits']} | {b['net']} | {b['gross']} | "
                    f"{f(b['rework'])} | {f(b['retention'])} | {f(b['entropy'])} | "
                    f"{f(b['per_commit'], 0)} |\n")

def draw_bench(by_month, path, zh):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    if not by_month:
        return False
    L = dict(title='WebPaint 逐月自省 benchmark', ent='变更熵 (0–1)',
             rew='返工率 (删/增)', x='月份') if zh else \
        dict(title='WebPaint monthly self-benchmark', ent='change entropy (0–1)',
             rew='rework ratio (del/add)', x='month')
    months = [m for m, _ in by_month]
    ent = [b['entropy'] for _, b in by_month]
    rew = [b['rework'] for _, b in by_month]
    xs = list(range(len(months)))

    fig, ax1 = plt.subplots(figsize=(12, 5))
    ax1.bar(xs, rew, color='#e45756', alpha=0.55, label=L['rew'])
    ax1.set_ylabel(L['rew'], color='#c0392b')
    ax1.set_xticks(xs)
    ax1.set_xticklabels(months, rotation=45, ha='right')
    ax1.set_xlabel(L['x'])
    ax2 = ax1.twinx()
    ax2.plot(xs, ent, color='#4c78a8', lw=2, marker='o', ms=4, label=L['ent'])
    ax2.set_ylabel(L['ent'], color='#2c5985')
    ax2.set_ylim(0, 1)
    ax1.set_title(L['title'])
    ax1.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return True

# --------------------------------------------------------------------- charts ---

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
    ap.add_argument('--no-lizard', action='store_true', help='跳过静态复杂度（不装 lizard）')
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

    # benchmark
    overall = bench_bucket(commits)
    by_month = bench_by_month(commits)
    static = static_metrics(root, not args.no_lizard)
    bench_md = os.path.join(out, 'benchmark.md')
    bench_png = os.path.join(out, 'benchmark.png')
    write_benchmark(overall, by_month, static, bench_md)
    drew_b = draw_bench(by_month, bench_png, zh)

    print(f'✓ {len(commits)} commits，现 ≈ {commits[-1]["total"]} 行')
    print(f'  返工率 {overall["rework"]:.2f} · 净留存 {overall["retention"]:.2f} · '
          f'变更熵 {overall["entropy"]:.2f}'
          + (f' · 平均圈复杂度 {static["ccn_mean"]:.1f}/最大 {static["ccn_max"]}'
             if static else ' · (无 lizard)'))
    print(f'  表   {csv_p}')
    print(f'  概述 {md_p}')
    print(f'  记分卡 {bench_md}')
    if drew:
        print(f'  图   {png_p}')
    if drew_b:
        print(f'  月图 {bench_png}')

if __name__ == '__main__':
    main()
