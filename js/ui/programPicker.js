// 音色(General MIDI の 128 音色)を選ぶ部品。トラックの音のダイアログに置く(formDialog の custom の欄)。
// セレクトボックスだと 128 個を縦にスクロールすることになるので、絞り込みの欄と、系統ごとの見出しと音色のボタンを
// 縦に流して、入り切らない分を隣の列へ折り返す一覧にしている(段組みは CSS の columns。PC幅では横にスクロールし、
// スマホ幅では1列で縦にスクロールする)。押した音色は、その場で1音鳴らして聞ける。

import { filterPrograms, GM_PROGRAMS } from '../domain/midi.js';
import { h } from './components/dom.js';

const programLabel = (program) => `${program + 1}. ${GM_PROGRAMS[program]}`;

/**
 * @param {string} id 絞り込みの欄に付ける id(ダイアログのラベルが指す)
 * @param {number} initial 選んでおく音色(0 始まり)
 * @param {{ onPreview?: (program: number) => void }} [options] onPreview は音色を押したとき(試し弾き)
 * @returns {HTMLElement & { value: string }} value は選んでいる音色の番号(0 始まり)の文字列
 */
export function programPicker(id, initial, { onPreview } = {}) {
   let value = initial;
   const current = h('p', { class: 'program-current muted' });
   const list = h('div', { class: 'program-list' });
   const filter = h('input', {
      id,
      class: 'input',
      type: 'search',
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

   function select(program) {
      value = program;
      current.textContent = `選択中: ${programLabel(program)}`;
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
                  el.closest('form')?.requestSubmit();
               },
            }, programLabel(program))),
         ])
         : [h('p', { class: 'program-empty muted' }, '合う音色がありません')]));
   }

   const el = h('div', { class: 'program-picker' }, filter, current, list);
   Object.defineProperty(el, 'value', { get: () => String(value) });
   render();
   select(value);
   // ダイアログに入ってから、選んでいる音色が見える位置までスクロールする
   // (PC幅では横に、スマホ幅では縦に)
   requestAnimationFrame(() => list.querySelector('.program-option[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
   return el;
}
