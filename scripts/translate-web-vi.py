#!/usr/bin/env python3
"""Machine-translate web console strings en -> vi through an Anthropic-compatible
endpoint (9router). Resumable: only strings whose vi value still equals the
English value are sent; the vi file is saved after every batch."""
import json, os, re, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOC = os.path.join(ROOT, 'apps/web/src/locales')
PRIORITY = ['common', 'pages', 'devices', 'scripts', 'alerts', 'organizations', 'settings', 'remote',
            'patches', 'vulnerabilities', 'monitoring', 'reports', 'errors', 'auth', 'policies', 'security']
BATCH = int(os.environ.get('BATCH', '120'))
PAUSE = float(os.environ.get('PAUSE', '6'))
MAX_BATCHES = int(os.environ.get('MAX_BATCHES', '0'))  # 0 = unlimited

def env(key, default=''):
    if os.environ.get(key): return os.environ[key]
    try:
        for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
            if line.startswith(key + '='): return line.split('=', 1)[1].strip()
    except FileNotFoundError: pass
    return default

BASE = env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').rstrip('/')
KEY = env('ANTHROPIC_API_KEY') or env('ANTHROPIC_AUTH_TOKEN')
MODEL = os.environ.get('TRANSLATE_MODEL') or env('ANTHROPIC_MODEL')
TOKENS = re.compile(r'\{\{[^}]+\}\}|</?[A-Za-z0-9_]+[^>]*>|\$t\([^)]*\)|%[sd]')

SYSTEM = (
    "You translate UI strings of Breeze, an IT remote monitoring and management (RMM) web console, "
    "from English to Vietnamese for IT staff in Vietnam. The input is a JSON object mapping ids to English "
    "strings. Reply with ONLY a JSON object with the same ids mapped to Vietnamese, no commentary, no code fences. "
    "Rules: keep every {{placeholder}}, tag such as <strong>...</strong> or <1>...</1>, $t(...) and %s exactly as-is "
    "and translate only the human-readable text around them. Keep brand and product names (Breeze, Windows, macOS, "
    "Linux, Microsoft 365, Google, Slack...), acronyms (CPU, RAM, CVE, KEV, MFA, SSO, API, VPN, RDP, SSH, URL, IP, "
    "DNS, PSA, RMM...) and code, file or command names unchanged. Use short, natural Vietnamese UI wording: "
    "Save=Lưu, Cancel=Hủy, Delete=Xóa, Edit=Sửa, Device=Thiết bị, Site=Chi nhánh, Organization=Tổ chức, "
    "Alert=Cảnh báo, Patch=Bản vá, Policy=Chính sách, Ticket=Phiếu hỗ trợ, Settings=Cài đặt, Dashboard=Tổng quan. "
    "Keep labels as short as the English. Preserve leading/trailing spaces and punctuation such as ':' and '…'."
)

def walk(node, path=()):
    if isinstance(node, dict):
        for k, v in node.items(): yield from walk(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node): yield from walk(v, path + (i,))
    elif isinstance(node, str):
        yield path, node

def get_path(node, path):
    for p in path: node = node[p]
    return node

def set_path(node, path, value):
    for p in path[:-1]:
        node = node.setdefault(p, {}) if isinstance(node, dict) else node[p]
    node[path[-1]] = value

def call_model(batch):
    body = json.dumps({'model': MODEL, 'max_tokens': 16000, 'system': SYSTEM,
                       'messages': [{'role': 'user', 'content': json.dumps(batch, ensure_ascii=False)}]}).encode()
    req = urllib.request.Request(BASE + '/v1/messages', data=body, method='POST', headers={
        'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) breeze-translate/1.0',
        'x-api-key': KEY, 'authorization': 'Bearer ' + KEY})
    raw = urllib.request.urlopen(req, timeout=180).read().decode('utf-8')
    if raw.lstrip().startswith('event:') or '\ndata:' in raw:  # server-sent events
        text = ''
        for line in raw.splitlines():
            if line.startswith('data:'):
                try: ev = json.loads(line[5:].strip())
                except ValueError: continue
                if ev.get('type') == 'content_block_delta' and ev.get('delta', {}).get('type') == 'text_delta':
                    text += ev['delta']['text']
    else:
        text = ''.join(b.get('text', '') for b in json.loads(raw).get('content', []) if b.get('type') == 'text')
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end < start: raise ValueError('no JSON object in reply')
    return json.loads(text[start:end + 1])

def translate_namespace(ns, budget):
    en = json.load(open(os.path.join(LOC, 'en', ns + '.json'), encoding='utf-8'))
    vi_path = os.path.join(LOC, 'vi', ns + '.json')
    vi = json.load(open(vi_path, encoding='utf-8'))
    todo = []
    for path, text in walk(en):
        try: current = get_path(vi, path)
        except (KeyError, IndexError, TypeError): current = text; set_path(vi, path, text)
        if current == text and re.search(r'[A-Za-z]', TOKENS.sub('', text)):
            todo.append((path, text))
    print(f'[{ns}] {len(todo)} string(s) to translate', flush=True)
    done = skipped = 0
    for i in range(0, len(todo), BATCH):
        if budget is not None and budget[0] <= 0: break
        chunk = todo[i:i + BATCH]
        batch = {str(n): text for n, (_, text) in enumerate(chunk)}
        result = None
        for attempt in range(5):
            try:
                result = call_model(batch); break
            except urllib.error.HTTPError as e:
                wait = 60 if e.code in (429, 500, 502, 503, 504) else 0
                print(f'  HTTP {e.code}: {e.read()[:150]!r}' + (f' - waiting {wait}s' if wait else ''), flush=True)
                if not wait: return False
                time.sleep(wait)
            except Exception as e:
                print(f'  error: {e} - retrying in 20s', flush=True); time.sleep(20)
        if result is None: print('  giving up on this batch', flush=True); continue
        for n, (path, src) in enumerate(chunk):
            tr = result.get(str(n))
            if isinstance(tr, str) and tr.strip() and sorted(TOKENS.findall(src)) == sorted(TOKENS.findall(tr)):
                set_path(vi, path, tr); done += 1
            else:
                skipped += 1
        with open(vi_path, 'w', encoding='utf-8') as f:
            json.dump(vi, f, ensure_ascii=False, indent=2); f.write('\n')
        print(f'  [{ns}] {min(i + BATCH, len(todo))}/{len(todo)} (ok {done}, kept English {skipped})', flush=True)
        if budget is not None: budget[0] -= 1
        time.sleep(PAUSE)
    return True

if __name__ == '__main__':
    if not (KEY and MODEL): sys.exit('ANTHROPIC_API_KEY/ANTHROPIC_MODEL not found in .env')
    names = sys.argv[1:] or PRIORITY + sorted(f[:-5] for f in os.listdir(os.path.join(LOC, 'en'))
                                              if f.endswith('.json') and f[:-5] not in PRIORITY)
    budget = [MAX_BATCHES] if MAX_BATCHES else None
    print(f'model={MODEL} base={BASE} batch={BATCH}', flush=True)
    for ns in names:
        if not translate_namespace(ns, budget): sys.exit('stopped: non-retryable HTTP error')
        if budget is not None and budget[0] <= 0: print('batch budget used up'); break
    print('done', flush=True)
