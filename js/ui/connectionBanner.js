// Supabase に保存しているときの、オフラインのお知らせ。
// 失敗はその都度トーストで出すが、トーストは消えてしまうので、オフラインの間はヘッダーの下に出し続ける。
// IndexedDB に保存しているときは、オフラインでも読み書きできるので出さない。

import { notify } from '../state.js';
import { h, icon } from './components/dom.js';

let banner = null;

function update() {
   const offline = !navigator.onLine;
   if (offline && !banner) {
      banner = h('div', { class: 'offline-banner', role: 'status' },
         icon('wifi-off'),
         h('span', null, 'オフラインです。Supabase に接続できないため、この間の変更は保存されません。'));
      document.querySelector('.app-header').after(banner);
   } else if (!offline && banner) {
      banner.remove();
      banner = null;
      // オフラインの間に失敗した操作が画面に残っていないように、保存先から読み直して描き直す
      notify();
   }
}

/** Supabase に保存するときに、アプリの開始時に1回呼ぶ。 */
export function watchConnection() {
   window.addEventListener('online', update);
   window.addEventListener('offline', update);
   update();
}
