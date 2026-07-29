/* 每日文獻 — 首頁邏輯
 * 資料只有一份 data/papers.json（由 build.py 依 papers/ 內的檔案產生），
 * 全部載進記憶體做即時過濾；離線時 Service Worker 會直接回快取，行為與線上一致。
 */
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var statEl = document.getElementById('stat');
  var chipsEl = document.getElementById('chips');
  var qEl = document.getElementById('q');
  var clearEl = document.getElementById('clear');
  var refreshEl = document.getElementById('refresh');

  var papers = [];
  var activeCat = '';        // 篩選只認「論文類別」，證據等級、授權那類副標籤不進晶片列

  /* ── 工具 ───────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 把命中的字串包成 <mark>；先跳脫再比對，避免把使用者輸入當標籤解析
  function mark(text, needles) {
    var out = esc(text);
    if (!needles.length) return out;
    needles.forEach(function (n) {
      if (!n) return;
      var re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      out = out.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
    });
    return out;
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    var week = ['日', '一', '二', '三', '四', '五', '六'][
      new Date(+m[1], +m[2] - 1, +m[3]).getDay()];
    return m[1] + '.' + m[2] + '.' + m[3] + '（' + week + '）';
  }

  function haystack(p) {
    return [p.title, p.title_en, p.journal, p.authors, p.design, p.doi, p.date,
            p.series, p.tldr, (p.tags || []).join(' ')].join(' ').toLowerCase();
  }

  /* ── 繪製 ───────────────────────────────────── */
  function render() {
    var raw = qEl.value.trim();
    var needles = raw ? raw.split(/\s+/) : [];
    var lowered = needles.map(function (n) { return n.toLowerCase(); });

    var shown = papers.filter(function (p) {
      if (activeCat && p.category !== activeCat) return false;
      if (!lowered.length) return true;
      var hay = p._hay;
      return lowered.every(function (n) { return hay.indexOf(n) !== -1; });
    });

    listEl.innerHTML = shown.map(function (p) {
      var tags = (p.tags || []).slice(0, 4).map(function (t) {
        return '<span class="tag">' + esc(t) + '</span>';
      }).join('');
      return '<li class="card"><a href="' + esc(p.file) + '">' +
        '<div class="head"><span class="date">' + esc(fmtDate(p.date)) + '</span>' +
        (p.series ? '<span>' + esc(p.series) + '</span>' : '') +
        (p.vol ? '<span>' + esc(p.vol) + '</span>' : '') + '</div>' +
        '<h2>' + mark(p.title, needles) + '</h2>' +
        (p.title_en ? '<p class="en">' + mark(p.title_en, needles) + '</p>' : '') +
        (p.journal || p.design
          ? '<p class="journal">' + (p.journal ? '<b>' + mark(p.journal, needles) + '</b>' : '') +
            (p.journal && p.design ? ' · ' : '') + (p.design ? mark(p.design, needles) : '') + '</p>'
          : '') +
        (p.tldr ? '<p class="tldr">' + mark(p.tldr, needles) + '</p>' : '') +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
        '</a></li>';
    }).join('');

    clearEl.hidden = !raw;
    var noHit = shown.length === 0;
    emptyEl.hidden = !noHit;
    if (noHit) {
      emptyEl.textContent = papers.length
        ? '沒有符合「' + (raw || activeCat) + (raw && activeCat ? ' · ' + activeCat : '') + '」的文獻。'
        : '還沒有任何文獻。明天早上的第一篇會自動出現在這裡。';
    }
    if (raw || activeCat) {
      statEl.innerHTML = '符合 ' + shown.length + ' 篇 / 共 ' + papers.length + ' 篇';
    } else {
      updateStat();
    }
  }

  function updateStat() {
    var latest = papers.length ? fmtDate(papers[0].date) : '—';
    var offline = navigator.onLine === false
      ? ' · <span class="off">離線閱讀中</span>' : '';
    statEl.innerHTML = '共 ' + papers.length + ' 篇 · 最新 ' + latest + offline;
  }

  function buildChips() {
    var count = {};
    papers.forEach(function (p) {
      if (p.category) count[p.category] = (count[p.category] || 0) + 1;
    });
    // 類別數量有限，全部列出；篇數多的排前面，同數依筆劃／字母序
    var cats = Object.keys(count).sort(function (a, b) {
      return count[b] - count[a] || a.localeCompare(b, 'zh-Hant');
    });
    if (!cats.length) { chipsEl.hidden = true; return; }
    chipsEl.hidden = false;

    chipsEl.innerHTML = ['<button type="button" class="chip" data-cat="" aria-pressed="true">全部</button>']
      .concat(cats.map(function (c) {
        return '<button type="button" class="chip" data-cat="' + esc(c) +
          '" aria-pressed="false">' + esc(c) + '<span class="n">' + count[c] + '</span></button>';
      })).join('');

    chipsEl.onclick = function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      activeCat = btn.dataset.cat === activeCat ? '' : btn.dataset.cat;
      Array.prototype.forEach.call(chipsEl.children, function (c) {
        c.setAttribute('aria-pressed', String(c.dataset.cat === activeCat));
      });
      render();
    };
  }

  /* ── 載入資料 ───────────────────────────────── */
  function load(opts) {
    return fetch('./data/papers.json', opts || {})
      .then(function (r) { return r.json(); })
      .then(function (data) {
        papers = (data.papers || []).map(function (p) {
          p._hay = haystack(p);
          return p;
        });
        buildChips();
        render();
      })
      .catch(function () {
        statEl.textContent = '讀不到文獻索引';
        emptyEl.hidden = false;
        emptyEl.textContent = '索引載入失敗。連上網後下拉即可重新整理。';
      });
  }

  /* ── 查詢列互動 ─────────────────────────────── */
  qEl.addEventListener('input', function () {
    sessionStorage.setItem('dl-q', qEl.value);
    render();
  });
  clearEl.addEventListener('click', function () {
    qEl.value = '';
    sessionStorage.removeItem('dl-q');
    qEl.focus();
    render();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== qEl) { e.preventDefault(); qEl.focus(); }
    if (e.key === 'Escape' && document.activeElement === qEl) { qEl.value = ''; render(); }
  });
  qEl.value = sessionStorage.getItem('dl-q') || '';

  window.addEventListener('online', updateStat);
  window.addEventListener('offline', updateStat);

  /* ── 主動更新：先請 SW 重抓全站，再重載 ─────── */
  var refreshing = false;
  function forceRefresh(spinEl) {
    if (refreshing) return;
    refreshing = true;
    if (spinEl) spinEl.classList.add('spin', 'loading');
    var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    var done = false;
    function finish() { if (!done) { done = true; location.reload(); } }
    if (!sw) { load({ cache: 'reload' }).then(finish); return; }
    navigator.serviceWorker.addEventListener('message', function onMsg(e) {
      if (e.data && e.data.type === 'REFRESHED') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        finish();
      }
    });
    sw.postMessage({ type: 'REFRESH' });
    setTimeout(finish, 8000);   // 離線或慢網路逾時：仍重載，至少沿用既有快取
  }
  refreshEl.addEventListener('click', function () { forceRefresh(refreshEl); });

  /* ── 下拉更新 ───────────────────────────────
   * 只在 PWA 獨立視窗啟用：瀏覽器分頁本來就有原生下拉更新，兩者疊在一起會打架。 */
  (function ptr() {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
    if (!standalone || !('ontouchstart' in window)) return;

    var THRESHOLD = 70, MAX_PULL = 110;
    var el = document.createElement('div');
    el.id = 'ptr';
    el.innerHTML = '<span>&#8595;</span>';
    document.body.appendChild(el);

    var startY = null, dist = 0, busy = false;

    function atTop() {
      var se = document.scrollingElement || document.documentElement;
      return se.scrollTop <= 0;
    }
    function innerScrolled(node) {
      while (node && node !== document.body) {
        if (node.scrollTop > 0) return true;
        node = node.parentNode;
      }
      return false;
    }
    function place(px) {
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + px + 'px)';
      el.classList.toggle('release', dist >= THRESHOLD);
    }
    function reset() {
      startY = null; dist = 0;
      el.style.transition = 'transform .25s';
      el.style.transform = 'translateY(0)';
      el.classList.remove('release');
    }

    document.addEventListener('touchstart', function (e) {
      if (busy || !atTop() || e.touches.length !== 1 || innerScrolled(e.target)) { startY = null; return; }
      startY = e.touches[0].clientY; dist = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (busy || startY === null) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) { if (dist > 0) reset(); return; }
      e.preventDefault();                    // 擋掉 iOS 橡皮筋，手勢才留得住
      dist = Math.min(MAX_PULL, dy * 0.5);   // 阻尼：拉 2px 移 1px
      place(dist + 48);                      // +48：指示器從畫面外滑入
    }, { passive: false });

    document.addEventListener('touchend', function () {
      if (busy || startY === null) return;
      if (dist >= THRESHOLD) {
        busy = true;
        el.classList.remove('release');
        el.classList.add('loading');
        el.style.transition = 'transform .2s';
        el.style.transform = 'translateY(' + (THRESHOLD + 48) + 'px)';
        setTimeout(function () { forceRefresh(null); }, 300);
      } else {
        reset();
      }
    }, { passive: true });
  })();

  /* ── 啟動 ───────────────────────────────────── */
  load();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js');
    });
  }
})();
