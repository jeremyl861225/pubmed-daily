/* 每日文獻 — Service Worker
 * 策略：stale-while-revalidate —— 一律先回快取（開啟即顯示，與離線同速），
 * 同時在背景抓最新版寫回快取，下次開啟即為新版。
 * 下拉更新（或按 ⟳）會送 REFRESH 訊息，強制逐檔查證後重新載入，可立即取得當天新論文。
 *
 * PRECACHE_URLS 與 BUILD 由 build.py 依 papers/ 實際檔案改寫，請勿手改。
 * BUILD 是內容指紋：只要任一檔案變動，sw.js 位元組就不同，瀏覽器才會偵測到新版 SW。
 *
 * 注意（同 origin 多個 PWA）：本站與 Clinical-Tools 等站共用 jeremyl861225.github.io，
 * activate 只能刪自己前綴的快取，否則會把別站的離線內容一併清掉。
 */
const CACHE_PREFIX = 'pubmed-daily-';
const CACHE_VERSION = CACHE_PREFIX + 'v1';
const BUILD = '13489182291a';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './data/papers.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-192-dark.png',
  './icons/icon-512.png',
  './icons/icon-512-dark.png',
  './icons/maskable-512.png',
  './icons/maskable-512-dark.png',
  './icons/apple-touch-icon.png',
  './papers/pubmed-benign-2026-08-01.html',
  './papers/pubmed-crs-2026-07-29.html',
  './papers/pubmed-crs-2026-08-02.html',
  './papers/pubmed-gs-breast-2026-08-01.html',
  './papers/pubmed-gs-endo-2026-07-30.html',
  './papers/pubmed-gs-endo-2026-08-04.html',
  './papers/pubmed-gs-gi-2026-07-31.html',
  './papers/pubmed-gs-peds-2026-08-03.html',
  './papers/pubmed-gs-txp-2026-08-02.html',
  './papers/pubmed-mis-2026-07-31.html',
  './papers/pubmed-mis-2026-08-04.html',
  './papers/pubmed-periop-2026-07-30.html',
  './papers/pubmed-periop-2026-08-03.html',
];

// 安裝：預先快取全部檔案（含每一篇論文），讓 App 可完全離線閱讀
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// 啟用：只清除本站舊版快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 擷取：有快取就立即回應，背景另抓新版更新快取
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);

    // 背景更新：no-cache 強制向伺服器查證（帶 ETag，未更動回 304 幾乎不耗流量），
    // 否則會沿用瀏覽器 HTTP 快取，而 GitHub Pages 送 max-age=600。
    const update = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(update);     // 維持 SW 存活到背景更新完成
      return cached;
    }

    const res = await update;
    if (res) return res;
    if (req.mode === 'navigate') {
      const home = await cache.match('./index.html');
      if (home) return home;
    }
    return Response.error();
  })());
});

/* 主動更新：逐檔向伺服器查證後通知頁面重新載入。
   用 no-cache 而非 reload：兩者都會問過伺服器，但 no-cache 帶 ETag，
   未更動的檔案回 304、幾乎不耗流量；論文只會愈積愈多，reload 會整包重抓。 */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'REFRESH') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(PRECACHE_URLS.map((u) =>
      fetch(u, { cache: 'no-cache' })
        .then((res) => (res && res.status === 200) ? cache.put(u, res) : null)
        .catch(() => null)          // 個別檔案失敗不影響其餘
    ));
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage({ type: 'REFRESHED' }));
  })());
});
