// Service Worker。インストールできるようにし、一度開いた画面をオフラインでも開けるようにする。
// ビルドステップがなくファイル名にバージョンが付かないので、自前のファイルはネットワーク優先にする
// (つながっていれば常に最新を使い、取れたものでキャッシュを更新する。つながらないときだけキャッシュを使う)。
// CDN のライブラリは URL にバージョンが入っていて中身が変わらないので、キャッシュ優先にする。
// Supabase への通信(別オリジン、GET 以外)には関わらない。
//
// キャッシュは補助に過ぎないので、Cache Storage が使えない(壊れている、容量の上限、ブラウザの制限など)ときも、
// ネットワークから取れるものは必ず返す。キャッシュの失敗で画面が開けなくなると、Service Worker を消すまで直らないため。

const CACHE = 'dtm-v1';
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', () => {
   self.skipWaiting();
});

self.addEventListener('activate', (event) => {
   event.waitUntil((async () => {
      // CACHE の名前を変えたときに、古いキャッシュを消す(消せなくても、管理下に置くところまでは進める)
      try {
         for (const key of await caches.keys()) {
            if (key !== CACHE) await caches.delete(key);
         }
      } catch {
         // 次に入れ替わったときに、また消そうとする
      }
      // 最初に開いた画面も、再読み込みを待たずにこの Service Worker の管理下に置く
      await self.clients.claim();
   })());
});

// 画面から、すでに読み込み済みのファイルの URL を受け取ってキャッシュする。
// 最初に開いたときの読み込みは Service Worker を通らないので、そのままでは次に開くまでオフラインで使えない
self.addEventListener('message', (event) => {
   if (event.data?.type !== 'cache-urls') return;
   event.waitUntil(Promise.all(event.data.urls.filter(isCacheable).map(async (url) => {
      try {
         if (await lookup(url)) return;
         await store(url, await fetch(url, { mode: sameOrigin(url) ? 'same-origin' : 'no-cors' }));
      } catch {
         // 取れなかったものは、次に使われたときにキャッシュされる
      }
   })));
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
   try {
      const response = await fetch(request);
      if (response.ok) await store(request, response);
      return response;
   } catch (error) {
      // ルーティングはハッシュ方式なので、クエリの違いは無視して同じページとみなす
      const cached = await lookup(request, { ignoreSearch: true });
      if (cached) return cached;
      throw error;
   }
}

async function cacheFirst(request) {
   const cached = await lookup(request);
   if (cached) return cached;
   const response = await fetch(request);
   // <script> で読む CDN のファイルは中身の見えない応答(opaque)になるので、ok ではなく type で判断する
   if (response.ok || response.type === 'opaque') await store(request, response);
   return response;
}

// キャッシュから探す。Cache Storage が使えなければ、無いものとして扱う
async function lookup(request, options) {
   try {
      return (await (await caches.open(CACHE)).match(request, options)) ?? null;
   } catch {
      return null;
   }
}

// キャッシュに入れる。入れられなくても(容量の上限など)、取れた応答はそのまま返したいので、失敗は無視する
async function store(request, response) {
   try {
      await (await caches.open(CACHE)).put(request, response.clone());
   } catch {
      // 次に使われたときに、また入れようとする
   }
}
