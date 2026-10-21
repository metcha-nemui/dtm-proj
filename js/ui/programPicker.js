// 音色(General MIDI の 128 音色)を選ぶ部品。トラックの音のダイアログに置く(formDialog の custom の欄)。
// コンボボックスにしている。閉じているときはセレクトボックスの見た目で選んでいる音色を出し、押すとドロップダウンに
// 絞り込みの欄と音色の一覧を出す。一覧は系統ごとの見出しと音色のボタンを縦に流し、入り切らない分を隣の列へ折り返して
// 横にスクロールする(段組みは CSS の columns)。ダイアログに一覧を広げたままだと、スマホの横持ちでは画面に入り切らないため。
// 押した音色は、その場で1音鳴らして聞ける(ドロップダウンは閉じないので、続けて聞き比べられる)。
//
// ドロップダウンは popover(最前面の層)に出す。ダイアログの中に置くと、ダイアログのスクロールで切れたり、
// 下の「キャンセル」「保存」の帯に隠れたりするため。位置はボタンを基準に、開くたびに計算する。

import { filterPrograms, GM_PROGRAMS } from '../domain/midi.js';
import { autoFocus, h, icon } from './components/dom.js';

const programLabel = (program) => `${program + 1}. ${GM_PROGRAMS[program]}`;

// ドロップダウンの高さの上限と、画面の端から空ける幅(px)
const PANEL_MAX_HEIGHT = 440;
const MARGIN = 8;

/**
 * @param {string} id 開くボタンに付ける id(ダイアログのラベルが指す)
 * @param {number} initial 選んでおく音色(0 始まり)
 * @param {{ onPreview?: (program: number) => void }} [options] onPreview は音色を押したとき(試し弾き)
 * @returns {HTMLElement & { value: string }} value は選んでいる音色の番号(0 始まり)の文字列
 */
export function programPicker(id, initial, { onPreview } = {}) {
   let value = initial;
   const currentLabel = h('span', { class: 'program-trigger-label' });
   const trigger = h('button', {
      id,
      type: 'button',
      class: 'select program-trigger',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
   }, currentLabel, icon('chevron-down', 16));
   const list = h('div', { class: 'program-list' });
   const filter = h('input', {
      class: 'input',
      type: 'search',
      'aria-label': '音色の絞り込み',
      placeholder: '絞り込み(例: piano、ストリングス、33)',
      autocomplete: 'off',
      oninput: () => render(),
      // Enter はフォームを送らず、絞り込んだ先頭の音色を選ぶ
      onkeydown: (e) => {
         if (e.key !== 'Enter' || e.isComposing) return;
         e.preventDefault();
         const first = filterPrograms(filter.value)[0]?.programs[0];
         if (first == null) return;
         select(first);
         onPreview?.(first);
      },
   });
   const panel = h('div', { class: 'program-panel', popover: 'auto' }, filter, list);
   // ボタンで開閉する(外を押す・Esc で閉じるのは popover に任せる)
   trigger.popoverTargetElement = panel;

   function select(program) {
      value = program;
      currentLabel.textContent = programLabel(program);
      for (const button of list.querySelectorAll('.program-option')) {
         button.setAttribute('aria-pressed', String(Number(button.dataset.program) === program));
      }
   }

   function render() {
      const groups = filterPrograms(filter.value);
      // 段組みで折り返すので、見出しと音色を同じ並びに平らに置く(系統ごとの入れ物で包むと、列をまたげない)
      list.replaceChildren(...(groups.length
         ? groups.flatMap(({ family, programs }) => [
            h('h3', { class: 'program-family' }, family),
            ...programs.map((program) => h('button', {
               type: 'button',
               class: 'program-option',
               dataset: { program: String(program) },
               'aria-pressed': String(program === value),
               title: programLabel(program),
               onclick: () => {
                  select(program);
                  onPreview?.(program);
               },
               // ダブルクリックなら、選んでそのまま保存する
               ondblclick: () => {
                  select(program);
                  panel.hidePopover();
                  el.closest('form')?.requestSubmit();
               },
            }, programLabel(program))),
         ])
         : [h('p', { class: 'program-empty muted' }, '合う音色がありません')]));
   }

   // ボタンの下(入り切らなければ上の、広い方)に、ボタンと同じ幅で出す
   function place() {
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - MARGIN * 2;
      const above = rect.top - MARGIN * 2;
      const height = Math.min(PANEL_MAX_HEIGHT, Math.max(below, above));
      const width = Math.min(rect.width, window.innerWidth - MARGIN * 2);
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
      panel.style.left = `${Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN))}px`;
      panel.style.top = `${below >= height || below >= above ? rect.bottom + MARGIN / 2 : rect.top - MARGIN / 2 - height}px`;
   }

   // 開いている間に画面が動いたら(ダイアログのスクロール、画面の回転、スマホのキーボードの開閉)、置き直す。
   // 閉じはしない(絞り込みの欄を押してキーボードが開くと、画面の大きさが変わるため)
   let abort = null;
   panel.addEventListener('toggle', (e) => {
      const open = e.newState === 'open';
      trigger.setAttribute('aria-expanded', String(open));
      abort?.abort();
      if (!open) return;
      abort = new AbortController();
      const options = { signal: abort.signal, capture: true };
      window.addEventListener('scroll', (ev) => {
         if (!panel.contains(ev.target)) place();
      }, options);
      window.addEventListener('resize', () => place(), options);
      // 選んでいる音色が見える位置まで横にスクロールする。スマホでは、絞り込みの欄にフォーカスを当てない(キーボードが開くため)
      list.querySelector('.program-option[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      autoFocus(filter);
   });
   // 位置は表示する前に決める(beforetoggle は popover が出る直前に来る)
   panel.addEventListener('beforetoggle', (e) => {
      if (e.newState === 'open') place();
   });

   const el = h('div', { class: 'program-picker' }, trigger, panel);
   Object.defineProperty(el, 'value', { get: () => String(value) });
   render();
   select(value);
   return el;
}
