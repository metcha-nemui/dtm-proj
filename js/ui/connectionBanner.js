// オンライン(Supabase)のタブを開いているときの、オフラインのお知らせ。
// 失敗はその都度トーストで出すが、トーストは消えてしまうので、オフラインの間は画面の上端に出し続ける。
// オフラインのタブ(IndexedDB)では、つながっていなくても読み書きできるので出さない。

import { currentMode, notify } from '../state.js';
import { h, icon } from './components/dom.js';

let banner = null;

/** つながり方か、開いている保存先が変わったときに呼ぶ。 */
export function updateConnection() {
   const show = !navigator.onLine && currentMode() === 'online';
   if (show && !banner) {
      banner = h('div', { class: 'offline-banner', role: 'status' },
         icon('wifi-off'),
         h('span', null, 'オフラインです。Supabase に接続できないため、この間の変更は保存されません。オフラインのタブなら作業できます。'));
      document.body.prepend(banner);
   } else if (!show && banner) {
      banner.remove();
      banner = null;
   }
}

function onConnectionChange() {
   updateConnection();
   // オフラインの間に失敗した操作が画面に残っていないように、保存先から読み直して描き直す
   if (navigator.onLine && currentMode() === 'online') notify();
}

/** アプリの開始時に1回呼ぶ。 */
export function watchConnection() {
   window.addEventListener('online', onConnectionChange);
   window.addEventListener('offline', onConnectionChange);
   updateConnection();
}
