#!/usr/bin/env python3
"""一键：画「代码行数 / 每次 commit」图 + 打 commit 概述 + 一组自省 benchmark。

用法（在 repo 任意子目录里跑都行）：
    python3 tools/loc-history.py                 # 全套：图 + csv + 概述 + benchmark
    python3 tools/loc-history.py --by session --gap 120   # benchmark 按「心流一坐」聚（默认）
    python3 tools/loc-history.py --by commit     # 或按 commit/day/month（都偏噪声/偏粗）
    python3 tools/loc-history.py --out /tmp/foo  # 换输出目录
    python3 tools/loc-history.py --branch prod   # 换分支/ref（默认当前 HEAD）
    python3 tools/loc-history.py --no-lizard     # 跳过静态复杂度（不装 lizard 也能跑）

  （建议用 venv 跑：~/venvs/pwa-tools/bin/python tools/loc-history.py）

产物（默认落 docs/reports/loc/）：
    loc-history.png      —— 上图=累计代码行数曲线(+里程碑竖线)，下图=每 commit 增删柱
    loc-history.csv      —— 同数据的表（seq,hash,date,added,deleted,net,total,subject）
    commit-summaries.md  —— 每次 commit 一行短概述
    benchmark.md         —— 自省记分卡（过程质量 + 成品质量 + 逐 session 表）
    benchmark.png        —— 逐 session「变更熵 + 返工率」图

里程碑（LOC 图上的竖线）来自 tools/loc-milestones.json（跟脚本同目录，已入库）。
要重新找里程碑：`--print-milestone-prompt` 打印固化规程，喂给一个读代码的 agent
让它读 commit-summaries.md 产出新 json；缺 json 时自动退化到「版本号跳变」启发式。

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

# 不算进「代码行数」的路径（只留「代码库本身的代码」）：
#   排除 vendored 依赖、构建产物、测试套件、文档、归档/人类区、所有 markdown。
EXCLUDE_PREFIX = ('vendor/', 'dist/', 'node_modules/', '.claude/',
                  'test/', 'tests/', 'docs/', 'doc/', 'ARCHIVE/', 'bench/',
                  'README.files/', 'journal/', 'journals/', 'workbench/',
                  '.deprecated/', '.github/')
EXCLUDE_SUFFIX = ('.md',)                       # 文档不算代码
EXCLUDE_SUBSTR = ('package-lock.json', 'esbuild')
# 测试文件也可能散在 src 里（*.test.ts / *.spec.ts）——一并排除
# 二进制文件 numstat 出 '-' '-'，本来就会被跳过
# 注：git 历史按 diff 原始行数累计，含注释（逐版剥注释代价太大）；
#     当前 tree 的「真·代码行数」用 lizard NLOC（去注释/空行），见 benchmark.md。

def repo_root():
    r = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('不在 git 仓库里：' + r.stderr.strip())
    return r.stdout.strip()

def model_family(trailer):
    """把 Co-Authored-By 值归一成模型名（Opus 4.7/4.8、Fable 5…）。"""
    t = trailer or ''
    if 'Fable' in t:
        return 'Fable 5'
    if 'Opus 4.8' in t:
        return 'Opus 4.8'          # 合并 (1M context) 与普通
    if 'Opus 4.7' in t:
        return 'Opus 4.7'
    if 'Opus' in t:
        return 'Opus (其他)'
    if 'Sonnet' in t:
        return 'Sonnet'
    if 'Haiku' in t:
        return 'Haiku'
    if 'Claude' in t:
        return 'Claude (其他)'
    return '(无标注)'

def commit_models(ref):
    """{full_hash: 模型名}——从 Co-Authored-By trailer 抽（多 co-author 取第一个模型）。"""
    r = subprocess.run(
        ['git', 'log',
         '--format=%H\x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)', ref],
        capture_output=True, text=True, errors='replace')
    m = {}
    for line in r.stdout.splitlines():
        if '\x1f' not in line:
            continue
        h, tr = line.split('\x1f', 1)
        m[h] = model_family(tr.split('\x1e')[0] if tr else '')
    return m

def excluded(path):
    if path.startswith(EXCLUDE_PREFIX) or path.endswith(EXCLUDE_SUFFIX):
        return True
    if '.test.' in path or '.spec.' in path:   # 散在 src 里的测试文件
        return True
    return any(s in path for s in EXCLUDE_SUBSTR)

def collect(ref):
    """返回按时间正序的 commit 记录列表。"""
    SEP = '\x1f'
    fmt = '@@@' + SEP.join(['%H', '%h', '%ad', '%at', '%an', '%s'])
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
            h, sh, date, at, author, subj = (line[3:].split(SEP) + [''] * 5)[:6]
            cur = dict(hash=h, short=sh, date=date, epoch=int(at or 0),
                       author=author, subject=subj, added=0, deleted=0, files={})
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

def bench_by_model(commits):
    """按 Co-Authored-By 模型分桶——Opus vs Fable performance eval 用。
    附时间跨度，因为不同模型往往只在某段时间用（这是比模型差异更大的混淆项）。"""
    groups = defaultdict(list)
    for c in commits:
        groups[c.get('model', '(无标注)')].append(c)
    rows = []
    for name, g in groups.items():
        b = bench_bucket(g)
        b['model'] = name
        b['date_min'] = min(c['date'] for c in g)
        b['date_max'] = max(c['date'] for c in g)
        rows.append(b)
    return sorted(rows, key=lambda b: -b['commits'])

def sessionize(commits, gap_min):
    """按提交时间间隔聚成「工作 session / 心流一坐」：
    相邻 commit 间隔 < gap_min 分钟 → 同一坐；超过就断新一坐。
    这才贴 solo-hobby-hyperfocus 的现实——一坐里那些来回小修都并进它该在的 burst。"""
    gap = gap_min * 60
    sessions, cur = [], []
    for c in commits:                  # commits 已是时间正序
        if cur and c['epoch'] - cur[-1]['epoch'] > gap:
            sessions.append(cur); cur = []
        cur.append(c)
    if cur:
        sessions.append(cur)
    return sessions

WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

def session_fields(sess):
    """一坐的结构化字段：起始(带星期) / 时长小时 / 短标签(给图用)。"""
    import datetime
    s = datetime.datetime.fromtimestamp(sess[0]['epoch'])
    dur_h = (sess[-1]['epoch'] - sess[0]['epoch']) / 3600
    start = f'{s:%Y-%m-%d %H:%M} {WEEKDAYS[s.weekday()]}'   # 2026-06-10 14:03 周三
    short = f'{s:%m-%d %H:%M}'                              # 图上 x 轴用
    return start, dur_h, short

def bench_buckets(commits, by, gap_min=120):
    """按 by 聚桶。返回 [(label, 记分卡), ...]，时间正序。
    by='session' → 心流一坐一桶（默认，gap_min 分钟断坐）——solo vibe coding 的自然单位
    by='commit'  → 每 commit 一桶（噪声大：bundle/docs/revert/来回小修都各算一桶）
    by='day'     → 每天一桶（跨午夜会切断通宵坐）
    by='month'   → 每月一桶（太粗，只当趋势看）"""
    if by == 'session':
        out = []
        for s in sessionize(commits, gap_min):
            b = bench_bucket(s)
            b['start'], b['dur_h'], short = session_fields(s)
            out.append((short, b))
        return out
    if by == 'commit':
        return [(c['short'], bench_bucket([c])) for c in commits]
    keyf = (lambda c: c['date']) if by == 'day' else (lambda c: c['date'][:7])
    groups = defaultdict(list)
    for c in commits:
        groups[keyf(c)].append(c)
    return [(k, bench_bucket(groups[k])) for k in sorted(groups)]

# --- 代码库「本身」质量（跟 rework 无关，只看当前 tree 的成品状态） ---------

import re as _re

# 去注释/字符串（含模板串），免得把注释里的词算进 Halstead
_STRIP = _re.compile(
    r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`',
    _re.DOTALL)
# 多字符运算符优先，再单字符标点；标识符；数字
_TOK = _re.compile(
    r'>>>=|\.\.\.|===|!==|>>>|\*\*=|<<=|>>=|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|'
    r'&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|\*\*|'
    r'[-+*/%=<>!~&|^?:;,.()\[\]{}]|'
    r'[A-Za-z_$][A-Za-z0-9_$]*|'
    r'\d[\w.]*')
_ID = _re.compile(r'[A-Za-z_$]')
# 当作 operator 的关键字（控制流/声明），其余标识符算 operand
_KW_OP = {'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'new',
          'delete', 'typeof', 'instanceof', 'in', 'of', 'void', 'throw', 'try',
          'catch', 'finally', 'function', 'class', 'extends', 'await', 'async',
          'yield', 'break', 'continue', 'const', 'let', 'var', 'import', 'export',
          'from', 'as', 'default', 'this', 'super'}

def halstead_volume(text):
    """轻量估算 Halstead Volume V = N·log2(n)（非 AST 精确，但 MI 对它取 log，稳）。"""
    code = _STRIP.sub(' ', text)
    ops, opnds = {}, {}
    for t in _TOK.findall(code):
        if _ID.match(t):
            (ops if t in _KW_OP else opnds).setdefault(t, 0)
            (ops if t in _KW_OP else opnds)[t] += 1
        else:
            ops[t] = ops.get(t, 0) + 1
    N = sum(ops.values()) + sum(opnds.values())
    n = len(ops) + len(opnds)
    return N * math.log2(n) if n > 0 else 0.0

def maintainability_index(volume, cc, loc):
    """Microsoft 变体，归一化到 0–100（越高越好维护）。"""
    if volume <= 0 or loc <= 0:
        return 100.0
    raw = 171 - 5.2 * math.log(volume) - 0.23 * cc - 16.2 * math.log(loc)
    return max(0.0, min(100.0, raw * 100 / 171))

def duplication_pct(file_lines, k=6):
    """块级重复率：k 行滑窗，出现≥2 次的窗覆盖了多少「有效行」。
    近似 PMD-CPD / GitClear 的 copy-paste 信号；语言无关，零依赖。"""
    TRIVIAL = {'{', '}', '},', '});', ')', ');', '};', '(', '/*', '*/', ''}
    win_count = defaultdict(int)
    per_file = []
    for lines in file_lines:
        norm = [ln.strip() for ln in lines]
        sig = [(i, s) for i, s in enumerate(norm) if s not in TRIVIAL and len(s) > 3]
        per_file.append((norm, sig))
        idxs = [i for i, _ in sig]
        for j in range(len(sig) - k + 1):
            key = tuple(s for _, s in sig[j:j + k])
            win_count[key] += 1
    dup_lines, total = 0, 0
    for norm, sig in per_file:
        total += len(sig)
        covered = set()
        for j in range(len(sig) - k + 1):
            key = tuple(s for _, s in sig[j:j + k])
            if win_count[key] >= 2:
                for i, _ in sig[j:j + k]:
                    covered.add(i)
        dup_lines += len(covered)
    return (100.0 * dup_lines / total) if total else 0.0

def static_metrics(root, use_lizard):
    """当前 tree 的成品质量标量（需 lizard 拿 CC/LOC；MI/重复率零依赖）。缺 lizard 返回 None。"""
    if not use_lizard:
        return None
    try:
        import lizard
    except ImportError:
        return None
    files = glob.glob(os.path.join(root, 'src', '**', '*.ts'), recursive=True)
    files = [f for f in files if not excluded(os.path.relpath(f, root).replace(os.sep, '/'))]
    ccn, lengths, nloc_tot, hotspots, long_fns, n = [], [], 0, 0, 0, 0
    mi_weighted, mi_files, mi_bad = 0.0, 0, 0
    all_lines = []
    for f in files:
        try:
            info = lizard.analyze_file(f)
            text = open(f, encoding='utf-8', errors='replace').read()
        except Exception:
            continue
        nloc_tot += info.nloc
        file_cc = 0
        for fn in info.function_list:
            n += 1
            ccn.append(fn.cyclomatic_complexity)
            lengths.append(fn.length)
            file_cc += fn.cyclomatic_complexity
            if fn.cyclomatic_complexity > 10:
                hotspots += 1
            if fn.length > 60:
                long_fns += 1
        # 每文件一个 MI，按 NLOC 加权求库级平均
        mi = maintainability_index(halstead_volume(text), file_cc, info.nloc or 1)
        mi_weighted += mi * (info.nloc or 1)
        mi_files += 1
        if mi < 65:
            mi_bad += 1
        all_lines.append(text.splitlines())
    if not n:
        return None
    return dict(
        files=len(files), functions=n, nloc=nloc_tot,
        ccn_mean=sum(ccn) / n, ccn_max=max(ccn),
        len_mean=sum(lengths) / n, len_max=max(lengths),
        hotspots=hotspots, long_fns=long_fns,
        mi=mi_weighted / nloc_tot if nloc_tot else 100.0,
        mi_bad=mi_bad, mi_files=mi_files,
        dup=duplication_pct(all_lines),
    )

def write_benchmark(overall, buckets, static, path, by, by_model=None):
    def f(x, d=2):
        return f'{x:.{d}f}'
    with open(path, 'w', encoding='utf-8') as o:
        o.write('# 自省记分卡\n\n')
        o.write('两类指标，别混：**过程质量**（怎么写出来的）和**成品质量**（现在代码本身好不好）。\n\n')

        # ---- Opus vs Fable：performance eval 的正主 ----
        if by_model:
            o.write('## 按模型（Opus vs Fable）\n\n')
            o.write('| 模型 | commits | 起讫 | 净增 | 总改动 | 返工率 | 净留存 | 变更熵 | 每commit |\n')
            o.write('|---|--:|:--|--:|--:|--:|--:|--:|--:|\n')
            for b in by_model:
                span = b['date_min'] if b['date_min'] == b['date_max'] else f"{b['date_min'][5:]}→{b['date_max'][5:]}"
                o.write(f"| {b['model']} | {b['commits']} | {span} | {b['net']} | {b['gross']} | "
                        f"{f(b['rework'])} | {f(b['retention'])} | {f(b['entropy'])} | {f(b['per_commit'],0)} |\n")
            o.write('\n> ⚠ 两个大坑，别急着下「A 比 B 强」：\n'
                    '> 1. **时间混淆**：每个模型往往只在某段时间用（看「起讫」）。项目越往后返工天然越高'
                    '（脚手架期 vs 深水区重构期），所以晚来的模型返工看着高、早退的看着低，未必是模型的功劳。\n'
                    '> 2. **返工率是「commit 内」删/增，不是「代码存活率」**：一个模型只做加法（新功能），'
                    '它当次 commit 返工=0；但它写的代码可能过几天被另一个模型删掉——那笔返工记在**别人**头上。'
                    '要真比「谁的代码留得住」，得按行做跨 commit 存活追踪（见 README 里 TODO），这张表还做不到。\n\n')

        # ---- 名词表：一句话说清每个数，怎么读、好坏往哪边 ----
        o.write('## 先看这个：每个数是什么意思\n\n')
        o.write('| 指标 | 是什么 | 往哪边好 | 你现在 |\n|---|---|---|--:|\n')
        o.write(f"| 返工率 | 删掉的行 ÷ 新写的行 | **越低越好**（0=从不回头改；0.5=写2删1） | {f(overall['rework'])} |\n")
        o.write(f"| 净留存 | 净增 ÷ 总改动 | **越高越好**（1=写下就留住；0=白忙） | {f(overall['retention'])} |\n")
        o.write(f"| 变更熵 | 改动摊在多少文件、多分散 (0–1) | 看情况（高=东一榔头西一棒，低=专注一处） | {f(overall['entropy'])} |\n")
        if static:
            o.write(f"| 可维护性 MI | 综合复杂度+体量的 0–100 分 | **越高越好**（>85 好维护，65–85 一般，<65 难缠） | {f(static['mi'],0)} |\n")
            o.write(f"| 重复率 | 复制粘贴的代码占比 | **越低越好**（<5% 健康，>10% 该抽函数了） | {f(static['dup'],1)}% |\n")
            o.write(f"| 圈复杂度 | 单函数平均分支数 | **越低越好**（<5 简单，>10 是热点） | {f(static['ccn_mean'],1)} |\n")
        o.write('\n')

        o.write('## 过程质量（全历史怎么写出来的）\n\n')
        o.write(f"- 代码量：净增 **{overall['net']}** 行（总改动 {overall['gross']}，"
                f"{overall['commits']} commits，碰过 {overall['touched']} 个文件）\n")
        o.write(f"- 返工率 **{f(overall['rework'])}** ｜ 净留存 **{f(overall['retention'])}** ｜ "
                f"变更熵 **{f(overall['entropy'])}** ｜ 每 commit 均改 **{f(overall['per_commit'],0)}** 行\n\n")

        o.write('## 成品质量（当前 tree · 只算 src/*.ts · 去测试/文档/注释）\n\n')
        if static:
            o.write(f"- **可维护性 MI = {f(static['mi'],0)}/100**"
                    f"（{static['mi_bad']}/{static['mi_files']} 个文件 <65 需盯）\n")
            o.write(f"- **重复率 = {f(static['dup'],1)}%**（块级，复制粘贴信号）\n")
            o.write(f"- 圈复杂度：平均 **{f(static['ccn_mean'])}**、最大 **{static['ccn_max']}**；"
                    f"热点(>10) **{static['hotspots']}** 个\n")
            o.write(f"- 规模：**{static['functions']}** 函数 / **{static['nloc']}** 行真·代码"
                    f"（NLOC，去注释空行）；函数均长 **{f(static['len_mean'],0)}** 行、最长 **{static['len_max']}**、"
                    f"超长(>60) **{static['long_fns']}** 个\n")
            o.write('> MI 里的 Halstead 体量用轻量 tokenizer 估（非 AST 精确，但 MI 对它取 log，够稳）。\n\n')
        else:
            o.write('> 没装 lizard，跳过成品质量。`pip install lizard` 后重跑即出。\n\n')

        gran = {'session': '每个心流一坐', 'commit': '每次 commit',
                'day': '每天', 'month': '每月'}[by]
        o.write(f'## 逐桶（{gran}）\n\n')
        if by == 'session':
            o.write('| 起始 | 时长 | commits | 净增 | 总改动 | 返工率 | 净留存 | 变更熵 |\n')
            o.write('|---|--:|--:|--:|--:|--:|--:|--:|\n')
            for _, b in buckets:
                o.write(f"| {b['start']} | {f(b['dur_h'],1)}h | {b['commits']} | {b['net']} | "
                        f"{b['gross']} | {f(b['rework'])} | {f(b['retention'])} | {f(b['entropy'])} |\n")
        else:
            head = {'commit': 'commit', 'day': '日期', 'month': '月份'}[by]
            o.write(f'| {head} | commits | 净增 | 总改动 | 返工率 | 净留存 | 变更熵 |\n')
            o.write('|---|--:|--:|--:|--:|--:|--:|\n')
            for label, b in buckets:
                o.write(f"| {label} | {b['commits']} | {b['net']} | {b['gross']} | "
                        f"{f(b['rework'])} | {f(b['retention'])} | {f(b['entropy'])} |\n")

def draw_bench(buckets, path, zh, by):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    if not buckets:
        return False
    unit = {'session': '坐', 'commit': 'commit', 'day': '天', 'month': '月'}[by] if zh else by
    L = dict(title=f'WebPaint 逐{unit}自省 benchmark（每点=一次{unit}）', ent='变更熵 (0–1)',
             rew='返工率 (删/增)', x=f'{unit}（时间正序）') if zh else \
        dict(title=f'WebPaint self-benchmark per {unit}', ent='change entropy (0–1)',
             rew='rework ratio (del/add)', x=f'{by} (chronological)')
    labels = [k for k, _ in buckets]
    ent = [b['entropy'] for _, b in buckets]
    rew = [b['rework'] for _, b in buckets]
    xs = list(range(len(labels)))
    n = len(labels)
    wide = n > 60   # commit 粒度：几百个点，细线 + 稀疏刻度

    fig, ax1 = plt.subplots(figsize=(13, 5))
    ax1.bar(xs, rew, color='#e45756', alpha=0.5,
            width=1.0 if wide else 0.8, label=L['rew'])
    ax1.set_ylabel(L['rew'], color='#c0392b')
    ax1.set_xlabel(L['x'])
    ax2 = ax1.twinx()
    if wide:
        ax2.plot(xs, ent, color='#4c78a8', lw=0.8, alpha=0.9, label=L['ent'])
    else:
        ax2.plot(xs, ent, color='#4c78a8', lw=2, marker='o', ms=4, label=L['ent'])
    ax2.set_ylabel(L['ent'], color='#2c5985')
    ax2.set_ylim(0, 1)
    # 稀疏刻度：点太多就只标 ~12 个
    step = max(1, n // 12)
    ticks = xs[::step]
    ax1.set_xticks(ticks)
    ax1.set_xticklabels([labels[i] for i in ticks], rotation=45, ha='right')
    ax1.set_title(L['title'])
    ax1.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return True

# ------------------------------------------------------------------ milestones ---
#
# 里程碑 = 时间线上值得标一笔的时刻（不是每个 commit）。语义判断 LLM 干得比正则好，
# 所以规程是：**派一个 explore/阅读 agent 按下面这段 prompt 读 commit-summaries.md，
# 产出 loc-milestones.json**；本工具读该 json 在 LOC 曲线上标竖线。
# json 没有时，自动退化到「版本号跳变」启发式(auto_milestones)先顶着。
#
# 固化的 agent prompt/规程（要重生成里程碑，就把这段喂给一个读代码的 agent）：
MILESTONE_PROMPT = r"""
你在为一条「代码行数随时间」曲线找**里程碑**，标在图上讲项目故事。
输入：commit 概述文件 commit-summaries.md，每行 `` `hash` YYYY-MM-DD (+增/-删) 标题 ``，旧→新。
挑人类会在时间线上标一笔的时刻，不是每个 commit：
  · 大功能/子系统首次登场（云同步、加密、笔刷引擎、图层组、选区、WebGL、i18n…）
  · 大架构落地/大重构（god-file 肢解、store 重写、渲染管线换代、语言迁移）
  · 版本纪元边界（v0.1.0/v0.2.0 这种 minor，或特别大的 vN 跳变），优先纪元而非每个补丁
  · 正式发布 / 生产 cutover
全历史挑 ~12–25 个，铺开别扎堆。每个输出对象：
  hash（该里程碑落地那次 commit 的短 hash）、date(YYYY-MM-DD)、
  label（≤16 字短标签，上图用，如「云同步」「加密」「WebGL重构」）、
  kind（release|feature|architecture|perf）、note（一句话为什么算里程碑）。
只输出一个 JSON 数组（旧→新），放在 ```json 代码块里，前后别加话。
""".strip()

# 数据文件 schema（loc-milestones.json）：
#   [ {hash, date, label, kind, note}, ... ]  —— 旧→新；hash 用来定位到曲线的 x 位置

KIND_COLOR = {'release': '#c0392b', 'feature': '#2c7fb8',
              'architecture': '#6a51a3', 'perf': '#2e8b57'}

def load_milestones(path, commits):
    """读 loc-milestones.json；没有就用启发式(版本号跳变)自动生成。
    返回 [(idx, milestone_dict), ...]，idx = 在 commits 里的序号。"""
    import json
    ms = None
    if path and os.path.exists(path):
        try:
            ms = json.load(open(path, encoding='utf-8'))
        except Exception as e:
            print(f'  (里程碑 json 读失败：{e}，退化到自动启发式)')
    if ms is None:
        ms = auto_milestones(commits)
        print(f'  (无 loc-milestones.json，自动挑了 {len(ms)} 个版本号里程碑；'
              f'想要语义里程碑就按 MILESTONE_PROMPT 派 agent 生成 json)')
    idx_of = {c['short']: i for i, c in enumerate(commits)}
    # 兼容全 hash：也按前缀匹配
    out, miss = [], 0
    for m in ms:
        h = m.get('hash', '')
        i = idx_of.get(h)
        if i is None:
            i = next((j for j, c in enumerate(commits)
                      if c['hash'].startswith(h) or c['short'].startswith(h)), None)
        if i is None:
            miss += 1
            continue
        out.append((i, m))
    if miss:
        print(f'  (里程碑有 {miss} 个 hash 在当前 ref 找不到，已跳过)')
    return sorted(out)

def auto_milestones(commits):
    """启发式兜底：挑「minor 版本纪元」——v0.X.0，以及每逢 vN 跨过 25 的整段首个 commit。"""
    import re as _re2
    out, last_bucket = [], None
    minor = _re2.compile(r'\bv(\d+)\.(\d+)\.0\b')          # v0.4.0 这种
    plain = _re2.compile(r'\bv(\d+)\b')                    # v351 这种
    for c in commits:
        s = c['subject']
        m = minor.search(s)
        if m:
            out.append(dict(hash=c['short'], date=c['date'],
                            label=f'v{m.group(1)}.{m.group(2)}.0', kind='release',
                            note=s[:40]))
            continue
        p = plain.search(s)
        if p:
            bucket = int(p.group(1)) // 25
            if bucket != last_bucket:
                last_bucket = bucket
                out.append(dict(hash=c['short'], date=c['date'],
                                label=f'v{p.group(1)}', kind='feature', note=s[:40]))
    return out

def draw_models(by_model, path, zh):
    """每模型：返工率 vs 变更熵 分组条，气泡大小=commits。诚实起见标注时间跨度。"""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    rows = [b for b in by_model if b['model'] != '(无标注)' and b['commits'] >= 2]
    if not rows:
        return False
    labels = [f"{b['model']}\n{b['commits']}c" for b in rows]
    rew = [b['rework'] for b in rows]
    ent = [b['entropy'] for b in rows]
    xs = list(range(len(rows)))
    w = 0.38
    L = dict(title='按模型：返工率 vs 变更熵（注意时间混淆，见 benchmark.md）',
             rew='返工率(删/增)', ent='变更熵(0–1)') if zh else \
        dict(title='per model: rework vs entropy (mind the time confound)',
             rew='rework (del/add)', ent='entropy (0–1)')
    fig, ax = plt.subplots(figsize=(max(7, len(rows) * 1.6), 5))
    ax.bar([x - w / 2 for x in xs], rew, w, color='#e45756', label=L['rew'])
    ax.bar([x + w / 2 for x in xs], ent, w, color='#4c78a8', label=L['ent'])
    ax.set_xticks(xs)
    ax.set_xticklabels(labels)
    ax.set_title(L['title'])
    ax.legend()
    ax.grid(True, axis='y', alpha=0.3)
    for x, b in zip(xs, rows):
        ax.text(x, max(b['rework'], b['entropy']) + 0.02,
                f"{b['date_min'][5:]}→{b['date_max'][5:]}",
                ha='center', va='bottom', fontsize=7, color='#555')
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return True

# --------------------------------------------------------------------- charts ---

def draw(commits, path, zh, milestones=None):
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

    # 里程碑：竖线 + 顶部斜标签（label 交错高低，避免挤成一团）
    if milestones:
        ymax = max(total) if total else 1
        for k, (i, m) in enumerate(milestones):
            col = KIND_COLOR.get(m.get('kind'), '#888')
            ax1.axvline(i, color=col, lw=0.9, ls='--', alpha=0.55)
            ax2.axvline(i, color=col, lw=0.9, ls='--', alpha=0.35)
            y = ymax * (1.02 + 0.06 * (k % 2))     # 交错两档高度
            ax1.text(i, y, m.get('label', ''), rotation=45, ha='left', va='bottom',
                     fontsize=7.5, color=col, clip_on=False)
        ax1.set_ylim(top=ymax * 1.18)

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
    ap.add_argument('--by', choices=['session', 'commit', 'day', 'month'],
                    default='session', help='benchmark 聚桶粒度（默认 session=心流一坐）')
    ap.add_argument('--gap', type=int, default=120,
                    help='session 断坐间隔（分钟，默认 120）；只在 --by session 时有意义')
    ap.add_argument('--no-lizard', action='store_true', help='跳过静态复杂度（不装 lizard）')
    ap.add_argument('--milestones', default=None,
                    help='里程碑 json（默认找 tools/loc-milestones.json；缺了退化到版本号启发式）')
    ap.add_argument('--print-milestone-prompt', action='store_true',
                    help='打印固化的里程碑寻找 prompt（喂给读代码 agent 重生成 json 用）')
    args = ap.parse_args()

    if args.print_milestone_prompt:
        print(MILESTONE_PROMPT)
        return

    root = repo_root()
    out = args.out or os.path.join(root, 'docs', 'reports', 'loc')
    os.makedirs(out, exist_ok=True)

    print(f'读历史：{args.branch} @ {root}')
    commits = collect(args.branch)
    if not commits:
        sys.exit('没读到 commit')
    models = commit_models(args.branch)         # 归属到 Opus/Fable/…
    for c in commits:
        c['model'] = models.get(c['hash'], '(无标注)')

    csv_p = os.path.join(out, 'loc-history.csv')
    md_p = os.path.join(out, 'commit-summaries.md')
    png_p = os.path.join(out, 'loc-history.png')
    write_csv(commits, csv_p)
    write_summaries(commits, md_p, args.width)
    zh = pick_font()
    if not zh:
        print('  (没找到中文字体，图里标签退英文——数据不受影响)')
    # 里程碑：默认找 tools/loc-milestones.json（挨着本脚本）
    ms_path = args.milestones or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                              'loc-milestones.json')
    milestones = load_milestones(ms_path, commits)
    drew = draw(commits, png_p, zh, milestones)

    # benchmark
    overall = bench_bucket(commits)
    buckets = bench_buckets(commits, args.by, args.gap)
    by_model = bench_by_model(commits)
    static = static_metrics(root, not args.no_lizard)
    bench_md = os.path.join(out, 'benchmark.md')
    bench_png = os.path.join(out, 'benchmark.png')
    models_png = os.path.join(out, 'models.png')
    write_benchmark(overall, buckets, static, bench_md, args.by, by_model)
    drew_b = draw_bench(buckets, bench_png, zh, args.by)
    drew_m = draw_models(by_model, models_png, zh)

    print(f'✓ {len(commits)} commits，产品代码累计 ≈ {commits[-1]["total"]} 行'
          f'（已去测试/文档/vendor；含注释）')
    if static:
        print(f'  成品质量：MI {static["mi"]:.0f}/100 · 重复率 {static["dup"]:.1f}% · '
              f'真·代码 {static["nloc"]} 行(去注释) · 圈复杂度均 {static["ccn_mean"]:.1f}/最大 {static["ccn_max"]}')
    print(f'  过程质量：返工率 {overall["rework"]:.2f} · 净留存 {overall["retention"]:.2f} · '
          f'变更熵 {overall["entropy"]:.2f}'
          + ('' if static else ' ·（无 lizard，成品质量跳过）'))
    print('  按模型（返工率/熵/commits，⚠时间混淆见 benchmark.md）：')
    for b in by_model:
        if b['model'] == '(无标注)':
            continue
        print(f'    {b["model"]:<12} 返工 {b["rework"]:.2f} · 熵 {b["entropy"]:.2f} · '
              f'{b["commits"]}c · {b["date_min"][5:]}→{b["date_max"][5:]}')
    print(f'  里程碑：{len(milestones)} 个标在 LOC 图上')
    print(f'  表   {csv_p}')
    print(f'  概述 {md_p}')
    print(f'  记分卡 {bench_md}')
    if drew:
        print(f'  图   {png_p}')
    if drew_b:
        print(f'  月图 {bench_png}')

if __name__ == '__main__':
    main()
