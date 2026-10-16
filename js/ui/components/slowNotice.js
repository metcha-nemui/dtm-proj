// 通信に時間が掛かっている操作を知らせる。Supabase では1操作に何度も通信するので、
// 待たされているのか止まっているのかが分からないと、同じ操作を繰り返したり画面を閉じたりしてしまう。
// - 5秒を過ぎても終わらなければ「処理中」を出し、終わるまで出し続ける(複数あれば、すべて終わるまで)
// - 3秒以上かかって正常に終わったら、終わったことをトーストで知らせる
// 失敗したときは何も足さない(呼び出し元が reportError でエラーを出す)。

import { showProgress, showToast } from './toast.js';

const DONE_NOTICE_MS = 3000;
const PROGRESS_NOTICE_MS = 5000;

const pending = new Set(); // 「処理中」を出す時間を過ぎて、まだ終わっていない操作
let hideProgress = null;

function updateProgress() {
   if (pending.size > 0) {
      if (!hideProgress) hideProgress = showProgress('処理中です…(通信に時間が掛かっています)');
   } else {
      hideProgress?.();
      hideProgress = null;
   }
}

/**
 * promise の完了を見張る。時間は呼び出した時点から測る(前の操作の終わりを待っている間も、ユーザーは待たされているため)。
 * @template T
 * @param {Promise<T>} promise
 * @param {string} [doneMessage] 時間が掛かって正常に終わったときの文言
 * @returns {Promise<T>} promise そのもの
 */
export function watchSlow(promise, doneMessage = '保存が完了しました') {
   const startedAt = performance.now();
   const token = {};
   const timer = setTimeout(() => {
      pending.add(token);
      updateProgress();
   }, PROGRESS_NOTICE_MS);
   const finish = () => {
      clearTimeout(timer);
      pending.delete(token);
      updateProgress();
   };
   // 呼び出し元より先に登録するので、呼び出し元が続けて出すトースト(元に戻すなど)の方が残る
   promise.then(() => {
      finish();
      if (performance.now() - startedAt >= DONE_NOTICE_MS) showToast(doneMessage);
   }, finish);
   return promise;
}
