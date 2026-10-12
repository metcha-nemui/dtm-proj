// トースト。同時に出すのは1件だけで、新しいものが古いものを置き換える。

import { h } from './dom.js';

let timer = null;

/**
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, duration?: number }} [options]
 */
export function showToast(message, { actionLabel, onAction, duration = 7000 } = {}) {
   const root = document.getElementById('toast-root');
   const dismiss = () => {
      clearTimeout(timer);
      toast.remove();
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
   root.replaceChildren(toast);
   timer = setTimeout(dismiss, duration);
}

/** 操作の失敗をユーザーに知らせる。 */
export function reportError(error) {
   console.error(error);
   showToast(error?.message ?? String(error));
}
