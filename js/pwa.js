// Service Worker(sw.js)の登録。インストールとオフラインでの起動のため。
// 登録に失敗しても(非対応のブラウザ、file:// など)、アプリはそのまま使える。

export function registerServiceWorker() {
   if (!('serviceWorker' in navigator)) return;
   window.addEventListener('load', async () => {
      try {
         await navigator.serviceWorker.register('./sw.js');
         const registration = await navigator.serviceWorker.ready;
         // 最初に開いたときに読み込んだファイルは Service Worker を通っていないので、改めてキャッシュしてもらう
         const urls = [location.href.split('#')[0], ...performance.getEntriesByType('resource').map((entry) => entry.name)];
         registration.active?.postMessage({ type: 'cache-urls', urls });
      } catch (error) {
         console.warn('Service Worker を登録できませんでした', error);
      }
   });
}
