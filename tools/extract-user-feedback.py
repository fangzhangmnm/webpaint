import json, sys, glob, re, os
SKIP = re.compile(r'<system-reminder>|<command-name>|<local-command|tool_use_error|\[Request interrupted|<ide_opened_file>|<task-notification>')
def extract(files, out):
    n = 0
    with open(out, 'w') as o:
        for fp in sorted(files, key=os.path.getmtime):
            for line in open(fp, encoding='utf-8', errors='replace'):
                try: d = json.loads(line)
                except: continue
                if d.get('type') != 'user' or d.get('isSidechain'): continue
                c = d.get('message', {}).get('content')
                if isinstance(c, str): texts = [c]
                elif isinstance(c, list): texts = [b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text']
                else: continue
                for t in texts:
                    t = t.strip()
                    if t and not SKIP.search(t):
                        o.write('### ' + t + '\n\n'); n += 1
    return n
base = os.path.expanduser('~/.claude/projects')
outdir = os.path.expanduser('~/.claude/jobs/5c6ec5c3/tmp/userlogs')
for d in sorted(os.listdir(base)):
    if not d.startswith('-mnt-d-JupyterLocal-20260601-PWAProjects'): continue
    name = re.sub(r'.*PWAProjects-*', '', d) or 'CLUSTER-ROOT'
    files = glob.glob(os.path.join(base, d, '*.jsonl'))
    if not files: continue
    n = extract(files, os.path.join(outdir, name + '.md'))
    print(f'{name}: {n} msgs')
