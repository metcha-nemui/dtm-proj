// シンプルなストア。repository の参照と、データ変更の通知(subscribe/notify)だけを持つ。
// 画面は notify を受けたら repository から読み直して再描画する。

let repository = null;
const listeners = new Set();

export function setRepository(impl) {
   repository = impl;
}

export function repo() {
   if (!repository) throw new Error('repository が初期化されていません');
   return repository;
}

/** @returns {() => void} 購読解除の関数 */
export function subscribe(listener) {
   listeners.add(listener);
   return () => listeners.delete(listener);
}

export function notify(change = {}) {
   for (const listener of [...listeners]) listener(change);
}
