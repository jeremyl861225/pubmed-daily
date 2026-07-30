#!/usr/bin/env python3
"""每日文獻站台的建索引程式。

做三件事：
  1. 掃 papers/*.html，解析出標題、期刊、標籤等欄位 → data/papers.json（首頁與搜尋的資料來源）
  2. 在每篇論文頁尾注入浮動工具列：回文獻列表／加入精選／回到最上面（可重複執行，會就地換成最新版）
  3. 依實際檔案改寫 sw.js 的預快取清單，讓新論文一併可離線閱讀

只用標準函式庫；GitHub Actions 上不必安裝任何套件。
論文 HTML 由 cowork 產生，版型日後可能微調，因此每個欄位都採「主要規則 + 退路」解析，
抓不到就留空，絕不讓整份索引失敗。
"""

import hashlib
import html as html_mod
import json
import os
import re
import sys
from datetime import date, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
PAPERS_DIR = os.path.join(ROOT, 'papers')
DATA_DIR = os.path.join(ROOT, 'data')
SW_PATH = os.path.join(ROOT, 'sw.js')

# sw.js 預快取清單中，論文以外的固定檔案
STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/style.css',
    './js/app.js',
    './data/papers.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png',
]

TAG_RE = re.compile(r'<[^>]+>')
WS_RE = re.compile(r'\s+')

# 科別分頁：先看檔名中段代碼（pubmed-crs-2026-07-29 → crs），抓不到再看刊頭系列名。
# 日後多一個科別，這裡多一行即可；沒對到的會自成一個分頁，不會憑空消失。
STREAMS = [
    ('crs', '大腸直腸', ('crs', 'colorectal', 'cr'), ('大腸', '直腸', 'Colorectal')),
    ('gs', '一般外科', ('gs', 'general'), ('一般外科', 'General surg')),
]


def text_of(fragment):
    """把一段 HTML 變成純文字：<br> 當空白、去標籤、還原實體、收斂空白。"""
    if not fragment:
        return ''
    s = re.sub(r'<br\s*/?>', ' ', fragment, flags=re.I)
    s = TAG_RE.sub('', s)
    s = html_mod.unescape(s)
    return WS_RE.sub(' ', s).strip()


def first(pattern, source, group=1):
    m = re.search(pattern, source, re.I | re.S)
    return m.group(group) if m else ''


def parse_date(name, source, path):
    """日期優先順序：檔名 → <title> → 內文的「YYYY 年 M 月 D 日」→ 檔案時間。"""
    for candidate in (name, first(r'<title[^>]*>(.*?)</title>', source)):
        m = re.search(r'(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})', candidate)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            try:
                return date(y, mo, d).isoformat()
            except ValueError:
                pass
    m = re.search(r'(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', source)
    if m:
        y, mo, d = (int(x) for x in m.groups())
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            pass
    return datetime.fromtimestamp(os.path.getmtime(path)).date().isoformat()


def parse_meta_grid(source):
    """<div class="meta-item"><div class="k">欄名</div><div class="v">內容</div></div> → dict。"""
    pairs = re.findall(
        r'<div[^>]*class="[^"]*\bk\b[^"]*"[^>]*>(.*?)</div>\s*'
        r'<div[^>]*class="[^"]*\bv\b[^"]*"[^>]*>(.*?)</div>',
        source, re.I | re.S)
    return {text_of(k): text_of(v) for k, v in pairs}


def pick(meta, *keywords):
    for key, value in meta.items():
        if any(word in key for word in keywords):
            return value
    return ''


def parse_tldr(source):
    """取「一句話結論」：以 tldr 區塊內第一段為主，退而求其次取正文第一段。"""
    idx = source.find('id="tldr"')
    if idx == -1:
        idx = source.find('class="tldr"')
    if idx != -1:
        para = first(r'<p[^>]*>(.*?)</p>', source[idx:idx + 8000])
        if para:
            return text_of(para)
    body = source[source.find('</header>'):] if '</header>' in source else source
    for para in re.findall(r'<p[^>]*>(.*?)</p>', body, re.I | re.S):
        plain = text_of(para)
        if len(plain) > 40:
            return plain
    return ''


def parse_stream(name, series):
    """判定科別分頁。回傳 (代碼, 顯示名)。"""
    token = ''
    m = re.match(r'(?:pubmed|paper)[-_]([a-z]+)', os.path.splitext(name)[0], re.I)
    if m:
        token = m.group(1).lower()
    for key, label, codes, words in STREAMS:
        if token and token in codes:
            return key, label
        if series and any(w in series for w in words):
            return key, label
    # 沒對到就用系列名自成一個分頁；連系列名都沒有才歸「其他」
    return (token or 'other'), (series or '其他')


def parse_paper(path):
    name = os.path.basename(path)
    with open(path, encoding='utf-8') as fh:
        source = fh.read()

    doc_title = text_of(first(r'<title[^>]*>(.*?)</title>', source))
    title = text_of(first(r'<h1[^>]*class="[^"]*title[^"]*"[^>]*>(.*?)</h1>', source)) \
        or text_of(first(r'<h1[^>]*>(.*?)</h1>', source)) \
        or re.split(r'\s*[·|]\s*', doc_title)[0] \
        or os.path.splitext(name)[0]

    kicker = first(r'<div[^>]*class="[^"]*kicker[^"]*"[^>]*>(.*?)</div>', source)
    kicker_parts = [text_of(s) for s in re.findall(r'<span[^>]*>(.*?)</span>', kicker, re.I | re.S)]
    kicker_parts = [p for p in kicker_parts if p and p != '/']
    series = next((p for p in kicker_parts if not re.match(r'^(Vol\.|20\d{2})', p)), '')
    vol = next((p for p in kicker_parts if p.lower().startswith('vol')), '')

    meta = parse_meta_grid(source)

    # 論文頁的標籤：class 只有 tag 的是「論文類別」，帶 t2／t3 的是證據等級、授權之類的副標籤。
    # 首頁的篩選晶片只用類別，其餘照樣顯示在卡片上。
    tagged = re.findall(r'<span[^>]*class="([^"]*\btag\b[^"]*)"[^>]*>(.*?)</span>', source, re.I | re.S)
    tags = [text_of(t) for _, t in tagged]
    category = next((text_of(t) for cls, t in tagged if cls.split() == ['tag'] and text_of(t)), '')
    if not category and tags:
        category = tags[0]

    series = series or re.split(r'\s*[·|]\s*', doc_title)[0]
    stream, stream_label = parse_stream(name, series)

    return {
        'id': os.path.splitext(name)[0],
        'file': 'papers/' + name,
        'date': parse_date(name, source, path),
        'stream': stream,
        'stream_label': stream_label,
        'series': series,
        'vol': vol,
        'title': title,
        'title_en': text_of(first(r'<p[^>]*class="[^"]*title-en[^"]*"[^>]*>(.*?)</p>', source)),
        'journal': pick(meta, '期刊', 'Journal'),
        'authors': pick(meta, '作者', 'Author'),
        'design': pick(meta, '研究設計', '設計', 'Design'),
        'doi': pick(meta, 'DOI'),
        'category': category,
        'tags': [t for t in tags if t],
        'tldr': parse_tldr(source)[:400],
        'bytes': os.path.getsize(path),
    }


TOOLBAR_MARK = '<!-- daily-lit-toolbar -->'
OLD_MARKS = (TOOLBAR_MARK, '<!-- daily-lit-backlink -->')

# 閱讀時的浮動工具列：回列表、加入精選、回到最上面。
# 論文頁是獨立 HTML，樣式與行為都得內嵌；精選存在 localStorage，與首頁共用同一份 dl-favs。
TOOLBAR = TOOLBAR_MARK + """
<style>
  /* left:50% 的固定定位元素可用寬度只剩一半視窗，不給 width:max-content 按鈕文字會被折行 */
  .dl-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));
    z-index:9999;display:flex;align-items:center;gap:8px;
    width:max-content;max-width:calc(100vw - 24px);}
  .dl-bar .dl-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;
    border:0;border-radius:20px;background:rgba(27,28,30,.9);color:#fff;cursor:pointer;
    font:600 14px/1 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;
    text-decoration:none;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.22);
    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}
  .dl-bar .dl-back{padding:0 18px;}
  .dl-bar .dl-fav,.dl-bar .dl-top{width:40px;font-size:17px;padding:0;}
  .dl-bar .dl-fav[aria-pressed="true"]{background:#8a4a3d;}
  .dl-bar .dl-btn:active{opacity:.75;}
  .dl-bar .dl-top[hidden]{display:none;}
  @media print{.dl-bar{display:none;}}
</style>
<div class="dl-bar" data-paper-id="__ID__">
  <a class="dl-btn dl-back" href="../index.html">&#8592; 文獻列表</a>
  <button type="button" class="dl-btn dl-fav" aria-pressed="false" aria-label="加入精選">&#9734;</button>
  <button type="button" class="dl-btn dl-top" aria-label="回到最上面" hidden>&#8593;</button>
</div>
<script>
(function () {
  var bar = document.currentScript.previousElementSibling;
  var id = bar.getAttribute('data-paper-id');
  var fav = bar.querySelector('.dl-fav');
  var top = bar.querySelector('.dl-top');

  function read() {
    try { return JSON.parse(localStorage.getItem('dl-favs')) || []; } catch (e) { return []; }
  }
  function paint(list) {
    var on = list.indexOf(id) !== -1;
    fav.setAttribute('aria-pressed', String(on));
    fav.innerHTML = on ? '&#9733;' : '&#9734;';
    fav.setAttribute('aria-label', on ? '取消精選' : '加入精選');
  }
  paint(read());

  fav.addEventListener('click', function () {
    var list = read();
    var i = list.indexOf(id);
    if (i === -1) { list.push(id); } else { list.splice(i, 1); }
    try { localStorage.setItem('dl-favs', JSON.stringify(list)); } catch (e) {}
    paint(list);
  });

  top.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // 捲過一屏才出現，免得一開頁就擋住內文
  window.addEventListener('scroll', function () {
    top.hidden = window.pageYOffset < 400;
  }, { passive: true });
})();
</script>
<!-- /daily-lit-toolbar -->
"""


def strip_injected(source):
    """把注入過的工具列（含舊版只有返回鍵的那版）拆掉，還原成 cowork 的原始內容。"""
    for mark in OLD_MARKS:
        i = source.find(mark)
        if i != -1 and '</body>' in source:
            return source[:i] + source[source.rindex('</body>'):]
    return source


def inject_toolbar(path):
    """重寫論文頁尾端的工具列。已是最新版就不動檔案，避免每次建索引都產生差異。"""
    with open(path, encoding='utf-8') as fh:
        source = fh.read()
    if '</body>' not in source:
        return False

    base = strip_injected(source)
    head, _, tail = base.rpartition('</body>')
    block = TOOLBAR.replace('__ID__', os.path.splitext(os.path.basename(path))[0])
    updated = head + block + '</body>' + tail
    if updated == source:
        return False
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(updated)
    return True


def update_sw(paper_files):
    """把預快取清單換成目前實際存在的檔案，並依內容指紋更新 BUILD 註記。

    只列真的存在的檔案：清單裡有抓不到的檔，install 會整批失敗，離線就全掛。
    """
    urls = [u for u in STATIC_ASSETS
            if u in ('./',) or os.path.exists(os.path.join(ROOT, u[2:]))]
    urls += ['./papers/' + os.path.basename(p) for p in paper_files]

    fingerprint = hashlib.sha1()
    for rel in urls:
        if rel == './':
            continue
        fpath = os.path.join(ROOT, rel[2:])
        if os.path.exists(fpath):
            fingerprint.update(rel.encode())
            with open(fpath, 'rb') as fh:
                fingerprint.update(hashlib.sha1(fh.read()).digest())
    stamp = fingerprint.hexdigest()[:12]

    with open(SW_PATH, encoding='utf-8') as fh:
        sw = fh.read()
    listing = 'const PRECACHE_URLS = [\n' + \
              ''.join("  '%s',\n" % u for u in urls) + '];'
    sw = re.sub(r'const PRECACHE_URLS = \[.*?\];', listing, sw, flags=re.S)
    sw = re.sub(r"const BUILD = '[^']*';", "const BUILD = '%s';" % stamp, sw)
    with open(SW_PATH, 'w', encoding='utf-8') as fh:
        fh.write(sw)
    return len(urls), stamp


def main():
    # 給 import 腳本用：印出「拆掉注入內容後」的檔案，好跟 cowork 的原始檔比對
    if len(sys.argv) == 3 and sys.argv[1] == '--strip':
        with open(sys.argv[2], encoding='utf-8') as fh:
            sys.stdout.write(strip_injected(fh.read()))
        return 0

    if not os.path.isdir(PAPERS_DIR):
        print('找不到 papers/，先建立資料夾再放論文 HTML', file=sys.stderr)
        return 1

    files = sorted(os.path.join(PAPERS_DIR, n) for n in os.listdir(PAPERS_DIR)
                   if n.lower().endswith('.html') and not n.startswith('.'))

    injected = sum(1 for f in files if inject_toolbar(f))
    papers = [parse_paper(f) for f in files]
    papers.sort(key=lambda p: (p['date'], p['id']), reverse=True)

    os.makedirs(DATA_DIR, exist_ok=True)
    payload = {
        'count': len(papers),
        'latest': papers[0]['date'] if papers else '',
        'papers': papers,
    }
    with open(os.path.join(DATA_DIR, 'papers.json'), 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write('\n')

    cached, stamp = update_sw(files)
    print('論文 %d 篇（工具列更新 %d）· 預快取 %d 檔 · build %s'
          % (len(papers), injected, cached, stamp))
    for p in papers[:5]:
        print('  %s  %s' % (p['date'], p['title'][:42]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
