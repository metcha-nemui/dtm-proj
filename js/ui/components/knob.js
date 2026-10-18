// つまみ(ノブ)。アレンジ画面のトラックの見出しで、音量とパンを変えるのに使う。
// 上下にドラッグで値を変え(Shift を押しながらだと細かく)、ダブルクリックで既定値に戻す。↑↓←→キーでも1ずつ動く。
// ホイールは使わない(トラックの一覧の縦スクロールとぶつかるため)。
// 並べ替えのつまみ(Sortable の handle)の中に置くので、要素は button にして Sortable の filter に掛かるようにしている。

import { h } from './dom.js';
import { trackPointer } from './pointer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SWEEP = 270; // 目盛りの円弧の角度(真下を空ける)
const PX_PER_STEP = 1.5; // 1 動かすのに要るドラッグの量(px)
const FINE = 4; // Shift を押しているときは、この倍の量で 1 動く

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

// 真上を 0 度として、時計回りに deg 度の点
function point(deg, r) {
   const rad = ((deg - 90) * Math.PI) / 180;
   return `${10 + r * Math.cos(rad)} ${10 + r * Math.sin(rad)}`;
}

function arc(from, to, r) {
   if (Math.abs(to - from) < 0.01) return '';
   const [a, b] = from < to ? [from, to] : [to, from];
   return `M ${point(a, r)} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${point(b, r)}`;
}

function svgEl(tag, attrs) {
   const el = document.createElementNS(SVG_NS, tag);
   for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
   return el;
}

/**
 * @param {object} options
 * @param {number} options.value
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number} options.reset ダブルクリックで戻す値
 * @param {boolean} [options.bipolar] 真ん中(reset)から左右に振る表示にする(パン)
 * @param {string} options.label 「音量」など
 * @param {(value: number) => string} [options.format] title に出す値の表記
 * @param {(value: number) => void} [options.onInput] 動かしている間、値が変わるたびに呼ぶ
 * @param {(value: number) => void} [options.onChange] 動かし終えたとき(値が変わっていれば)に呼ぶ
 * @param {() => void} [options.onDragStart] ドラッグを始めたとき(この間は作り直されないようにしてもらう)
 * @param {() => void} [options.onDragEnd]
 * @param {string} [options.focusKey] 再描画でフォーカスを引き継ぐための data-focus-key
 */
export function knob({
   value, min = 0, max = 127, reset, bipolar = false, label, format = String,
   onInput, onChange, onDragStart, onDragEnd, focusKey,
}) {
   let current = value;
   const track = svgEl('path', { class: 'knob-track', d: arc(-SWEEP / 2, SWEEP / 2, 7.5) });
   const fill = svgEl('path', { class: 'knob-fill' });
   const needle = svgEl('line', { class: 'knob-needle', x1: '10', y1: '10' });
   const svg = svgEl('svg', { viewBox: '0 0 20 20', width: '20', height: '20', 'aria-hidden': 'true' });
   svg.append(track, fill, needle);

   const el = h('button', {
      type: 'button',
      class: 'knob',
      role: 'slider',
      'aria-label': label,
      'aria-valuemin': String(min),
      'aria-valuemax': String(max),
      dataset: focusKey ? { focusKey } : {},
      onpointerdown: (e) => startDrag(e),
      ondblclick: () => commit(reset, current),
      onkeydown: (e) => {
         const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
         if (!step) return;
         e.preventDefault();
         e.stopPropagation(); // アレンジ画面の ←→(選んだクリップを動かす)に渡さない
         commit(current + step * (e.shiftKey ? 10 : 1), current);
      },
   }, svg);

   const angle = (v) => -SWEEP / 2 + ((v - min) / (max - min)) * SWEEP;

   function draw() {
      const deg = angle(current);
      const from = bipolar ? angle(reset) : -SWEEP / 2;
      fill.setAttribute('d', arc(from, deg, 7.5));
      const [x2, y2] = point(deg, 6).split(' ');
      needle.setAttribute('x2', x2);
      needle.setAttribute('y2', y2);
      el.setAttribute('aria-valuenow', String(current));
      el.setAttribute('aria-valuetext', format(current));
      el.title = `${label}: ${format(current)}(上下にドラッグ。Shift で細かく、ダブルクリックで ${format(reset)} に戻す)`;
   }

   function set(next) {
      const v = clamp(Math.round(next), min, max);
      if (v === current) return false;
      current = v;
      draw();
      onInput?.(current);
      return true;
   }

   function commit(next, before) {
      set(next);
      if (current !== before) onChange?.(current);
   }

   function startDrag(down) {
      if (down.button !== 0) return;
      down.preventDefault();
      el.focus({ preventScroll: true });
      const before = current;
      let base = current;
      let y = down.clientY;
      onDragStart?.();
      trackPointer(el, down, {
         onMove: (e) => {
            // Shift を途中で押しても飛ばないよう、動いた分だけを足していく
            base = clamp(base + (y - e.clientY) / (PX_PER_STEP * (e.shiftKey ? FINE : 1)), min, max);
            y = e.clientY;
            set(base);
         },
         onEnd: () => {
            onDragEnd?.();
            if (current !== before) onChange?.(current);
         },
      });
   }

   draw();
   return el;
}
