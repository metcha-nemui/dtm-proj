// SortableJS(CDNから読み込むグローバル)の薄いラッパー。

// ボタンや入力欄の上からでも掴めるように、ネイティブのドラッグではなくフォールバックを使う。
// タッチでは長押しで掴む(スクロールと区別するため)。
const DEFAULTS = {
   animation: 150,
   forceFallback: true,
   fallbackOnBody: true,
   fallbackTolerance: 5,
   delay: 200,
   delayOnTouchOnly: true,
   ghostClass: 'is-drag-ghost',
   dragClass: 'is-dragging',
};

/** @returns Sortable のインスタンス。CDNから読めなかった場合は null(ドラッグなしで使える) */
export function createSortable(el, options) {
   const { Sortable } = window;
   return Sortable ? Sortable.create(el, { ...DEFAULTS, ...options }) : null;
}

/** 同じ親の中で、selector に一致する兄弟の何番目にいるか。非表示の要素も数える。 */
export function domIndex(item, selector) {
   return [...item.parentElement.querySelectorAll(`:scope > ${selector}`)].indexOf(item);
}
