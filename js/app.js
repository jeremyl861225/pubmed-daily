/* 每日文獻 — 首頁邏輯
 * 資料只有一份 data/papers.json（由 build.py 依 papers/ 內的檔案產生），
 * 全部載進記憶體做即時過濾；離線時 Service Worker 會直接回快取，行為與線上一致。
 *
 * 三層篩選由上而下：科別分頁（大腸直腸／一般外科／精選）→ 類別晶片 → 查詢字串。
 * 精選存在 localStorage 的 dl-favs，論文頁裡注入的工具列讀寫同一份。
 */
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var statEl = document.getElementById('stat');
  var tabsEl = document.getElementById('tabs');
  var chipsEl = document.getElementById('chips');
  var chipWrapEl = document.getElementById('chipwrap');
  var qEl = document.getElementById('q');
  var clearEl = document.getElementById('clear');
  var refreshEl = document.getElementById('refresh');
  var topEl = document.getElementById('totop');
  var barEl = document.querySelector('.searchbar');

  var FAV_KEY = 'dl-favs';
  var FAV_TAB = '__fav__';
  // 固定先列這兩個科別，即使今天還沒有該科的論文也留著位子
  var BASE_TABS = [{ key: 'crs', label: '大腸直腸' }, { key: 'gs', label: '一般外科' }];

  var papers = [];
  var favs = readFavs();
  var activeTab = sessionStorage.getItem('dl-tab') || BASE_TABS[0].key;
  var activeCat = '';

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

  /* ── 精選 ───────────────────────────────────── */
  function readFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; }
  }
  function writeFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) {}
  }
  function isFav(id) { return favs.indexOf(id) !== -1; }
  function toggleFav(id) {
    var i = favs.indexOf(id);
    if (i === -1) { favs.push(id); } else { favs.splice(i, 1); }
    writeFavs();
  }

  /* ── 分頁 ───────────────────────────────────── */
  // 固定的兩個科別 + 資料裡出現過的其他科別（不讓任何一篇無處可去）
  function tabList() {
    var seen = {}, extra = [];
    papers.forEach(function (p) {
      var k = p.stream || 'other';
      if (seen[k]) return;
      seen[k] = true;
      if (!BASE_TABS.some(function (t) { return t.key === k; })) {
        extra.push({ key: k, label: p.stream_label || k });
      }
    });
    return BASE_TABS.concat(extra);
  }

  function inTab(p) {
    return activeTab === FAV_TAB ? isFav(p.id) : (p.stream || 'other') === activeTab;
  }

  function buildTabs() {
    var tabs = tabList();
    var html = tabs.map(function (t) {
      var n = papers.filter(function (p) { return (p.stream || 'other') === t.key; }).length;
      return '<button type="button" class="tab" role="tab" data-tab="' + esc(t.key) +
        '" aria-selected="' + (activeTab === t.key) + '">' + esc(t.label) +
        '<span class="n">' + n + '</span></button>';
    });
    html.push('<button type="button" class="tab fav" role="tab" data-tab="' + FAV_TAB +
      '" aria-selected="' + (activeTab === FAV_TAB) + '" aria-label="精選">' +
      (activeTab === FAV_TAB ? '★' : '☆') +
      '<span class="n">' + favs.length + '</span></button>');
    tabsEl.innerHTML = html.join('');
  }

  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn || btn.dataset.tab === activeTab) return;
    activeTab = btn.dataset.tab;
    activeCat = '';                       // 換科別時類別重來，免得留著上一頁的類別得到空清單
    sessionStorage.setItem('dl-tab', activeTab);
    buildTabs();
    buildChips();
    render();
    window.scrollTo(0, 0);
  });

  /* ── 類別晶片（只看目前分頁裡的論文）──────────── */
  function buildChips() {
    var count = {};
    papers.forEach(function (p) {
      if (inTab(p) && p.category) count[p.category] = (count[p.category] || 0) + 1;
    });
    var cats = Object.keys(count).sort(function (a, b) {
      return count[b] - count[a] || a.localeCompare(b, 'zh-Hant');
    });
    // 只有一種類別時篩選沒有意義，整列收起來
    if (cats.length < 2) {
      chipWrapEl.hidden = true;
      chipWrapEl.classList.remove('has-more');
      return;
    }
    chipWrapEl.hidden = false;

    chipsEl.innerHTML = ['<button type="button" class="chip" data-cat="" aria-pressed="' +
      (activeCat === '') + '">全部</button>']
      .concat(cats.map(function (c) {
        return '<button type="button" class="chip" data-cat="' + esc(c) +
          '" aria-pressed="' + (activeCat === c) + '">' + esc(c) +
          '<span class="n">' + count[c] + '</span></button>';
      })).join('');
    markChipOverflow();
  }

  chipsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    activeCat = btn.dataset.cat === activeCat ? '' : btn.dataset.cat;
    Array.prototype.forEach.call(chipsEl.children, function (c) {
      c.setAttribute('aria-pressed', String(c.dataset.cat === activeCat));
    });
    render();
  });

  /* ── 繪製 ───────────────────────────────────── */
  function render() {
    var raw = qEl.value.trim();
    var needles = raw ? raw.split(/\s+/) : [];
    var lowered = needles.map(function (n) { return n.toLowerCase(); });

    var pool = papers.filter(inTab);
    var shown = pool.filter(function (p) {
      if (activeCat && p.category !== activeCat) return false;
      if (!lowered.length) return true;
      var hay = p._hay;
      return lowered.every(function (n) { return hay.indexOf(n) !== -1; });
    });

    listEl.innerHTML = shown.map(function (p) {
      var tags = (p.tags || []).slice(0, 4).map(function (t) {
        return '<span class="tag">' + esc(t) + '</span>';
      }).join('');
      var on = isFav(p.id);
      return '<li class="card">' +
        '<a href="' + esc(p.file) + '">' +
        '<div class="head"><span class="date">' + esc(fmtDate(p.date)) + '</span>' +
        // 精選分頁混著兩科，改標科別；平時標系列名
        (activeTab === FAV_TAB
          ? '<span>' + esc(p.stream_label || p.series) + '</span>'
          : (p.series ? '<span>' + esc(p.series) + '</span>' : '')) +
        (p.vol ? '<span class="vol">' + esc(p.vol) + '</span>' : '') + '</div>' +
        '<h2>' + mark(p.title, needles) + '</h2>' +
        (p.title_en ? '<p class="en">' + mark(p.title_en, needles) + '</p>' : '') +
        (p.journal || p.design
          ? '<p class="journal">' + (p.journal ? '<b>' + mark(p.journal, needles) + '</b>' : '') +
            (p.journal && p.design ? ' · ' : '') + (p.design ? mark(p.design, needles) : '') + '</p>'
          : '') +
        (p.tldr ? '<p class="tldr">' + mark(p.tldr, needles) + '</p>' : '') +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
        '</a>' +
        '<button type="button" class="star" data-id="' + esc(p.id) + '" aria-pressed="' + on +
        '" aria-label="' + (on ? '取消精選' : '加入精選') + '">' +
        (on ? '★' : '☆') + '</button>' +
        '</li>';
    }).join('');

    clearEl.hidden = !raw;
    emptyEl.hidden = shown.length !== 0;
    if (!shown.length) emptyEl.innerHTML = emptyText(raw, pool.length);
    updateStat(shown.length, pool.length, raw);
  }

  function emptyText(raw, poolSize) {
    if (raw || activeCat) {
      return '沒有符合「' + esc(raw || activeCat) +
        (raw && activeCat ? ' · ' + esc(activeCat) : '') + '」的文獻。';
    }
    if (activeTab === FAV_TAB) {
      return '還沒有精選的文獻。<br>點卡片右上角的 ☆ 就會收進這裡。';
    }
    if (!papers.length) return '還沒有任何文獻。<br>明天早上的第一篇會自動出現在這裡。';
    if (!poolSize) return '這個分頁還沒有文獻。<br>之後每天早上會自動送進來。';
    return '沒有符合的文獻。';
  }

  function updateStat(shownCount, poolSize, raw) {
    var offline = navigator.onLine === false ? ' · <span class="off">離線閱讀中</span>' : '';
    if (raw || activeCat) {
      statEl.innerHTML = '符合 ' + shownCount + ' 篇 / 本頁 ' + poolSize + ' 篇' + offline;
      return;
    }
    if (activeTab === FAV_TAB) {
      statEl.innerHTML = '精選 ' + poolSize + ' 篇' + offline;
      return;
    }
    var latest = poolSize ? fmtDate(papers.filter(inTab)[0].date) : '—';
    statEl.innerHTML = '本頁 ' + poolSize + ' 篇 · 共 ' + papers.length + ' 篇 · 最新 ' +
      latest + offline;
  }

  // 星號在卡片連結之外，但仍在 li 內；用委派並擋掉預設行為，避免點星號時開啟論文
  listEl.addEventListener('click', function (e) {
    var star = e.target.closest('.star');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(star.dataset.id);
      buildTabs();
      if (activeTab === FAV_TAB) { buildChips(); render(); }   // 精選頁要即時把取消的那篇移掉
      else {
        var on = isFav(star.dataset.id);
        star.setAttribute('aria-pressed', String(on));
        star.setAttribute('aria-label', on ? '取消精選' : '加入精選');
        star.innerHTML = on ? '★' : '☆';
      }
      return;
    }
    if (e.target.closest('a')) sessionStorage.setItem('dl-scroll', String(window.pageYOffset));
  });

  /* ── 捲動相關 ───────────────────────────────── */
  // 類別放不下時，右緣加一道淡出提示可以橫向捲。
  // 量太早會量到還沒排版完的寬度（實測 rAF 那次會漏），所以字體就緒與稍後各再量一次。
  function markChipOverflow() {
    function check() {
      chipWrapEl.classList.toggle('has-more', chipsEl.scrollWidth > chipsEl.clientWidth + 4);
    }
    requestAnimationFrame(check);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(check);
    setTimeout(check, 400);
  }
  window.addEventListener('resize', markChipOverflow);

  function syncScrollUI() {
    var y = window.pageYOffset;
    barEl.classList.toggle('stuck', y > 4);      // 吸頂後補一道陰影，跟卡片分開
    topEl.hidden = y < 400;                      // 捲過一屏才出現回到頂端
  }
  window.addEventListener('scroll', syncScrollUI, { passive: true });
  topEl.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 點進論文再返回時回到原位：清單是 JS 畫的，瀏覽器自己還原會落在還沒繪好的頁面上
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function restoreScroll() {
    var y = sessionStorage.getItem('dl-scroll');
    sessionStorage.removeItem('dl-scroll');    // 只還原這一次，隔天重新開啟仍從頂端開始
    if (y) window.scrollTo(0, +y);
    syncScrollUI();                            // 程式捲動不一定會派送 scroll，狀態自己補
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
        // 精選裡若有已被刪掉的論文，順手清掉，數字才不會對不上
        var ids = {};
        papers.forEach(function (p) { ids[p.id] = true; });
        var kept = favs.filter(function (id) { return ids[id]; });
        if (kept.length !== favs.length) { favs = kept; writeFavs(); }

        buildTabs();
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

  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  /* ── 主動更新：先請 SW 重抓全站，再重載 ─────── */
  var refreshing = false;
  function forceRefresh(spinEl) {
    if (refreshing) return;
    refreshing = true;
    if (spinEl) spinEl.classList.add('spin');
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
  load().then(restoreScroll);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js');
    });
  }
})();
