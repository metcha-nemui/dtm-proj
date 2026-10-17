// Service Worker。インストールできるようにし、一度開いた画面をオフラインでも開けるようにする。
// ビルドステップがなくファイル名にバージョンが付かないので、自前のファイルはネットワーク優先にする
// (つながっていれば常に最新を使い、取れたものでキャッシュを更新する。つながらないときだけキャッシュを使う)。
// CDN のライブラリは URL にバージョンが入っていて中身が変わらないので、キャッシュ優先にする。
// Supabase への通信(別オリジン、GET 以外)には関わらない。

const CACHE = 'dtm-v1';
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', () => {
   self.skipWaiting();
});

self.addEventListener('activate', (event) => {
   event.waitUntil((async () => {
      // CACHE の名前を変えたときに、古いキャッシュを消す
      for (const key of await caches.keys()) {
         if (key !== CACHE) await caches.delete(key);
      }
      // 最初に開いた画面も、再読み込みを待たずにこの Service Worker の管理下に置く
      await self.clients.claim();
   })());
});

// 画面から、すでに読み込み済みのファイルの URL を受け取ってキャッシュする。
// 最初に開いたときの読み込みは Service Worker を通らないので、そのままでは次に開くまでオフラインで使えない
self.addEventListener('message', (event) => {
   if (event.data?.type !== 'cache-urls') return;
   event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(event.data.urls.filter(isCacheable).map(async (url) => {
         if (await cache.match(url)) return;
         try {
            await cache.put(url, await fetch(url, { mode: sameOrigin(url) ? 'same-origin' : 'no-cors' }));
         } catch {
            // 取れなかったものは、次に使われたときにキャッシュされる
         }
      }));
   })());
});

self.addEventListener('fetch', (event) => {
   const { request } = event;
   if (request.method !== 'GET' || !isCacheable(request.url)) return;
   event.respondWith(sameOrigin(request.url) ? networkFirst(request) : cacheFirst(request));
});

function sameOrigin(url) {
   return new URL(url).origin === self.location.origin;
}

function isCacheable(url) {
   return sameOrigin(url) || new URL(url).origin === CDN_ORIGIN;
}

async function networkFirst(request) {
   const cache = await caches.open(CACHE);
   try {
      const response = await fetch(request);
      if (response.ok) await store(cache, request, response);
      return response;
   } catch (error) {
      // ルーティングはハッシュ方式なので、クエリの違いは無視して同じページとみなす
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw error;
   }
}

async function cacheFirst(request) {
   const cache = await caches.open(CACHE);
   const cached = await cache.match(request);
   if (cached) return cached;
   const response = await fetch(request);
   // <script> で読む CDN のファイルは中身の見えない応答(opaque)になるので、ok ではなく type で判断する
   if (response.ok || response.type === 'opaque') await store(cache, request, response);
   return response;
}

// キャッシュに入れる。入れられなくても(容量の上限など)、取れた応答はそのまま返したいので、失敗は無視する
async function store(cache, request, response) {
   try {
      await cache.put(request, response.clone());
   } catch {
      // 次に使われたときに、また入れようとする
   }
}
