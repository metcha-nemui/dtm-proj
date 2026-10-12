// DOM生成のヘルパー。ユーザー入力は必ずテキストノードとして入れる(innerHTMLは使わない)。

/**
 * @param {string} tag
 * @param {Object|null} [attrs] class / dataset / style(オブジェクト) / onXxx(リスナー) / その他の属性
 * @param {...(Node|string|number|null|false|Array)} children
 */
export function h(tag, attrs, ...children) {
   const el = document.createElement(tag);
   for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value == null || value === false) continue;
      if (key === 'class') {
         el.className = value;
      } else if (key === 'dataset') {
         Object.assign(el.dataset, value);
      } else if (key === 'style') {
         for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
      } else if (key.startsWith('on') && typeof value === 'function') {
         el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && !key.includes('-')) {
         el[key] = value;
      } else {
         el.setAttribute(key, value === true ? '' : value);
      }
   }
   el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
   return el;
}

/**
 * Lucide(CDNから読み込むグローバル)のアイコン。
 * @param {string} name Lucide のアイコン名(例: 'ellipsis-vertical')
 * @param {number} [size] 幅と高さ(px)
 * @param {number} [strokeWidth] 線の太さ。省略すると Lucide の既定(2)
 */
export function icon(name, size = 16, strokeWidth = null) {
   const key = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
   const svg = window.lucide.createElement(window.lucide.icons[key]);
   svg.setAttribute('width', size);
   svg.setAttribute('height', size);
   svg.setAttribute('aria-hidden', 'true');
   if (strokeWidth) svg.setAttribute('stroke-width', strokeWidth);
   svg.classList.add('icon');
   return svg;
}

/** 進捗バー。ratio は 0〜1。 */
export function progressBar(ratio) {
   return h('div', { class: 'progress' }, h('span', { style: { width: `${Math.round(ratio * 100)}%` } }));
}

/**
 * 再描画(render)の前後で、フォーカスと入力中の値を保つ。
 * 対象は root の中で data-focus-key を持つ要素。再描画後に同じキーの要素へ引き継ぐ。
 */
export function keepFocus(root, render) {
   const active = root.contains(document.activeElement) ? document.activeElement : null;
   const key = active?.dataset.focusKey;
   const typing = key && active.matches('textarea, input:not([type=checkbox])')
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;

   render();

   const target = key && root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
   if (!target) return;
   target.focus({ preventScroll: true });
   if (!typing) return;
   target.value = typing.value;
   // number など、選択範囲を持たない入力欄では start が null になる
   if (typing.start != null) target.setSelectionRange(typing.start, typing.end);
}
