// シンプルなストア。repository の参照と、データ変更の通知(subscribe/notify)だけを持つ。
// 画面は notify を受けたら repository から読み直して再描画する。

let repository = null;
// repository の保存先。'online'(Supabase)か 'offline'(このブラウザの IndexedDB)。
// 保存先に届かないときも、画面のリンク先を決めるためにモードだけは持っておく
let mode = 'online';
const listeners = new Set();

/**
 * @param {object|null} impl 保存先に届かないときは null(書き込ませないように、repo() を失敗させる)
 * @param {'online'|'offline'} implMode
 */
export function setRepository(impl, implMode) {
   repository = impl;
   mode = implMode;
}

export function repo() {
   if (!repository) throw new Error('repository が初期化されていません');
   return repository;
}

/** @returns {'online'|'offline'} いま開いている保存先 */
export function currentMode() {
   return mode;
}

/** @returns {() => void} 購読解除の関数 */
export function subscribe(listener) {
   listeners.add(listener);
   return () => listeners.delete(listener);
}

export function notify(change = {}) {
   for (const listener of [...listeners]) listener(change);
}
