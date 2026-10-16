// トースト。同時に出すのは1件だけで、新しいものが古いものを置き換える。
// 「処理中」の表示(showProgress)は別枠で、トーストの上に重ねて出す(元に戻すトーストなどを消さないため)。

import { h, icon } from './dom.js';

let timer = null;
let current = null;
let progress = null;

/**
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, duration?: number }} [options]
 */
export function showToast(message, { actionLabel, onAction, duration = 7000 } = {}) {
   const root = document.getElementById('toast-root');
   const dismiss = () => {
      clearTimeout(timer);
      toast.remove();
      if (current === toast) current = null;
   };
   const toast = h('div', { class: 'toast' },
      h('span', null, message),
      actionLabel && h('button', {
         type: 'button',
         class: 'toast-action',
         onclick: () => {
            dismiss();
            onAction?.();
         },
      }, actionLabel));
   clearTimeout(timer);
   current?.remove();
   current = toast;
   root.append(toast);
   timer = setTimeout(dismiss, duration);
}

/**
 * 処理中の表示を出す(閉じるまで出し続ける)。出ていれば文言だけ差し替える。
 * @returns {() => void} 閉じる関数
 */
export function showProgress(message) {
   progress?.remove();
   const el = h('div', { class: 'toast toast-progress', role: 'status' }, icon('loader-circle'), h('span', null, message));
   progress = el;
   document.getElementById('toast-root').prepend(el);
   return () => {
      el.remove();
      if (progress === el) progress = null;
   };
}

/** 操作の失敗をユーザーに知らせる。 */
export function reportError(error) {
   console.error(error);
   showToast(error?.message ?? String(error));
}
