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

// Lucide に合うものがないアイコン。Lucide と同じ形(24×24 の座標に線で描く)で書き、同じ作り方で SVG にする。
// 外側の svg の属性は Lucide のアイコンが持っているものと同じ
const CUSTOM_ICON_ATTRS = {
   xmlns: 'http://www.w3.org/2000/svg',
   width: 24,
   height: 24,
   viewBox: '0 0 24 24',
   fill: 'none',
   stroke: 'currentColor',
   'stroke-width': 2,
   'stroke-linecap': 'round',
   'stroke-linejoin': 'round',
};
const CUSTOM_ICONS = {
   // リバーブ。左右に3重の弧 ((( ))) を広げ、外側ほど薄くして残響が減っていく感じを出す
   reverb: [
      ['path', { d: 'M10.5 9.4a3 3 0 0 0 0 5.2' }],
      ['path', { d: 'M13.5 9.4a3 3 0 0 1 0 5.2' }],
      ['path', { d: 'M8.75 6.37a6.5 6.5 0 0 0 0 11.26', opacity: '0.7' }],
      ['path', { d: 'M15.25 6.37a6.5 6.5 0 0 1 0 11.26', opacity: '0.7' }],
      ['path', { d: 'M7 3.34a10 10 0 0 0 0 17.32', opacity: '0.45' }],
      ['path', { d: 'M17 3.34a10 10 0 0 1 0 17.32', opacity: '0.45' }],
   ],
};

/**
 * Lucide(CDNから読み込むグローバル)のアイコン。CUSTOM_ICONS にある名前なら、そちらを使う。
 * @param {string} name Lucide のアイコン名(例: 'ellipsis-vertical')か CUSTOM_ICONS の名前
 * @param {number} [size] 幅と高さ(px)
 * @param {number} [strokeWidth] 線の太さ。省略すると Lucide の既定(2)
 */
export function icon(name, size = 16, strokeWidth = null) {
   const key = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
   const custom = CUSTOM_ICONS[name];
   const svg = window.lucide.createElement(custom ? ['svg', CUSTOM_ICON_ATTRS, custom] : window.lucide.icons[key]);
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

// 指で操作する画面(スマホ・タブレット)か。
export const isTouchScreen = () => matchMedia('(pointer: coarse)').matches;

// 文字の入力欄か(フォーカスが当たると、スマホではソフトウェアキーボードが開く)
const TEXT_ENTRY = 'textarea, input:not([type=checkbox], [type=radio], [type=range], [type=file], [type=color])';

/**
 * 開いた直後などに、入力欄へ自動でフォーカスを当てる。スマホでは当てない(キーボードが開いて、
 * 横持ちでは画面を占領してしまう。打つときは自分で欄を押す)。
 */
export function autoFocus(el) {
   if (!isTouchScreen()) el.focus();
}

/** スマホで、自動で入力欄に当たったフォーカスを外す(<dialog> の showModal が最初の欄に当てるため)。 */
export function dropAutoFocus(root) {
   const active = document.activeElement;
   if (isTouchScreen() && root.contains(active) && active.matches(TEXT_ENTRY)) active.blur();
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
