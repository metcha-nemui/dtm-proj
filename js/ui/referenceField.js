// リファレンス(参考にする楽曲の曲名)の入力欄。タスク詳細とクリップ詳細(連動タスクのリファレンス)で使う。
// 曲名は Enter か候補の選択で1件ずつ足し、チップの × で外す。候補は同じプロジェクトのタスクに付いている曲名から出す。
// 表記の違い(全角・半角、大文字・小文字など)しかない曲名は、既にある表記に揃えて足す。

import { canonicalizeReference, suggestReferences } from '../domain/reference.js';
import { h, icon } from './components/dom.js';

const SUGGESTION_LIMIT = 8; // 候補を一度に出す数

/**
 * @param {object} options
 * @param {() => string[]} options.getReferences いま付いている曲名
 * @param {(next: string[]) => void} options.onChange 曲名を足した・外したとき(保存は呼び出し側で行う)
 * @param {() => void} [options.onBlur] 入力欄からフォーカスが外れたとき(打ちかけの曲名は、その前に足す)
 * @returns {{ el: HTMLElement, setKnown: (names: string[]) => void, render: () => void,
 *   commitPending: () => void, reset: () => void }}
 *   setKnown は候補の元(プロジェクトのタスクに付いている曲名)を渡す。commitPending は打ちかけの曲名を足す
 */
export function createReferenceField({ getReferences, onChange, onBlur }) {
   let known = []; // プロジェクトのタスクに付いている曲名(候補の元)
   let suggestions = []; // 表示中の候補
   let active = -1; // キーボードで選んでいる候補。-1 なら選んでいない

   const list = h('ul', { class: 'ref-chips', 'aria-label': 'リファレンス' });
   const suggestionList = h('ul', { class: 'ref-suggestions', id: 'ref-suggestions', role: 'listbox', hidden: true });
   const input = h('input', {
      class: 'input',
      'aria-label': 'リファレンスを追加',
      placeholder: '曲名を入力して Enter',
      autocomplete: 'off',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-controls': 'ref-suggestions',
      'aria-expanded': 'false',
      oninput: () => updateSuggestions(),
      onkeydown: onKeydown,
      onblur: () => {
         closeSuggestions();
         commitPending();
         onBlur?.();
      },
   });
   const el = h('div', { class: 'ref-field' }, list, h('div', { class: 'ref-input' }, input, suggestionList));

   // そのタスクに付いていれば何もしない
   function add(name) {
      input.value = '';
      closeSuggestions();
      const references = getReferences();
      const canonical = canonicalizeReference(name, [...references, ...known]);
      if (!canonical || references.includes(canonical)) return;
      onChange([...references, canonical]);
      render();
   }

   function remove(name) {
      onChange(getReferences().filter((r) => r !== name));
      render();
      input.focus();
   }

   // 曲名を打ったまま閉じたり欄を離れたりしても、消さずに足す
   function commitPending() {
      if (input.value.trim()) add(input.value);
   }

   function render() {
      const references = getReferences();
      list.replaceChildren(...references.map((name) => h('li', { class: 'ref-chip' },
         h('span', { class: 'ref-chip-name' }, name),
         h('button', {
            type: 'button',
            class: 'ref-chip-remove',
            'aria-label': `「${name}」を外す`,
            onclick: () => remove(name),
         }, icon('x', 14)))));
      list.hidden = !references.length;
   }

   // 入力に合う候補を出す。force なら入力が空でも(↓キーで)出す
   function updateSuggestions({ force = false } = {}) {
      suggestions = input.value.trim() || force
         ? suggestReferences(input.value, known, getReferences()).slice(0, SUGGESTION_LIMIT)
         : [];
      active = -1;
      renderSuggestions();
   }

   function closeSuggestions() {
      suggestions = [];
      active = -1;
      renderSuggestions();
   }

   function renderSuggestions() {
      suggestionList.replaceChildren(...suggestions.map((name, i) => h('li', {
         id: `ref-suggestion-${i}`,
         class: 'ref-suggestion',
         role: 'option',
         'aria-selected': String(i === active),
         // 押した時点で入力欄のフォーカスが外れると、打ちかけの文字が先に足されてしまう
         onmousedown: (e) => e.preventDefault(),
         onclick: () => add(name),
      }, name)));
      suggestionList.hidden = !suggestions.length;
      input.setAttribute('aria-expanded', String(!suggestionList.hidden));
      if (active >= 0) {
         input.setAttribute('aria-activedescendant', `ref-suggestion-${active}`);
         suggestionList.children[active].scrollIntoView({ block: 'nearest' });
      } else {
         input.removeAttribute('aria-activedescendant');
      }
   }

   function onKeydown(e) {
      // 日本語入力の変換を確定する Enter は、曲名の決定に使わない
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
         e.preventDefault();
         if (!suggestions.length) updateSuggestions({ force: true });
         if (!suggestions.length) return;
         // 選択なし(-1)も含めて循環させる
         const step = e.key === 'ArrowDown' ? 1 : -1;
         active = ((active + 1 + step + suggestions.length + 1) % (suggestions.length + 1)) - 1;
         renderSuggestions();
      } else if (e.key === 'Enter') {
         e.preventDefault();
         const name = active >= 0 ? suggestions[active] : input.value;
         if (name.trim()) add(name);
      } else if (e.key === 'Escape' && suggestions.length) {
         // 候補だけを閉じ、ドロワーは閉じない
         e.preventDefault();
         closeSuggestions();
      }
   }

   return {
      el,
      setKnown: (names) => { known = names; },
      render,
      commitPending,
      reset: () => {
         input.value = '';
         closeSuggestions();
      },
   };
}
