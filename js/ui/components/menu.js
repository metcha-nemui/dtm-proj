// ボタンの下に出すポップアップメニュー。外側のクリック・Esc・スクロールで閉じる。

import { h } from './dom.js';

let current = null;

export function closeMenu() {
   current?.abort.abort();
   current?.menu.remove();
   current = null;
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{ label: string, onSelect: () => void, danger?: boolean }|null|false>} items
 */
export function openMenu(anchor, items) {
   // 開いているメニューのボタンをもう一度押したら閉じるだけ
   if (current?.anchor === anchor) {
      closeMenu();
      return;
   }
   closeMenu();

   const menu = h('div', { class: 'menu', role: 'menu' },
      items.filter(Boolean).map((item) => h('button', {
         type: 'button',
         role: 'menuitem',
         class: `menu-item${item.danger ? ' is-danger' : ''}`,
         onclick: () => {
            closeMenu();
            item.onSelect();
         },
      }, item.label)));
   document.getElementById('overlay-root').append(menu);

   const rect = anchor.getBoundingClientRect();
   const left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8));
   const below = rect.bottom + 4;
   const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 4) : below;
   menu.style.left = `${left}px`;
   menu.style.top = `${top}px`;

   const abort = new AbortController();
   const options = { signal: abort.signal, capture: true };
   document.addEventListener('pointerdown', (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
   }, options);
   document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeMenu();
      anchor.focus();
   }, options);
   window.addEventListener('scroll', closeMenu, options);
   window.addEventListener('resize', closeMenu, options);
   window.addEventListener('hashchange', closeMenu, options);

   current = { anchor, menu, abort };
   menu.querySelector('button')?.focus();
}
