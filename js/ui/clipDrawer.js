// クリップ詳細。タスク詳細と同じく、PCでは右ドロワー、スマホではボトムシートとして出す(見た目は共通のCSS)。
// 入力は欄を離れたとき(change)と閉じるときに保存する。

import * as actions from '../actions.js';
import { clipEnd } from '../domain/arrangement.js';
import { audibleNotes } from '../domain/midi.js';
import { repo, subscribe } from '../state.js';
import { h, icon } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';
import { clipMidi, downloadMidi } from './midiExport.js';

/** 「3〜6小節」のような範囲の表示。1小節なら「3小節目」。 */
export function barRange(clip) {
   return clip.bars === 1 ? `${clip.startBar}小節目` : `${clip.startBar}〜${clipEnd(clip)}小節`;
}

/**
 * @param {string} projectId
 * @param {{ onSelectionChange?: (clipId: string|null) => void, onOpenPianoRoll?: (clipId: string) => void,
 *   onDuplicate?: (clipId: string) => void }} [options]
 *   onDuplicate は「クリップを複製」を押したとき(置き場所はアレンジ画面で選ぶ)
 */
export function createClipDrawer(projectId, { onSelectionChange, onOpenPianoRoll, onDuplicate } = {}) {
   let clip = null; // 表示中のクリップ(最後に読み込んだ、または保存した状態)
   let context = null; // clip と一緒に読み込んだもの(.mid を作るのに、プロジェクトの BPM とトラックが要る)
   let el = null; // ドロワーのDOM。閉じている間は null
   let requested = null; // open() の競合を避けるための、最後に要求されたクリップID
   const run = (promise) => promise.catch(reportError);

   async function loadContext(clipId) {
      const [project, clips, tracks, tasks, lanes] = await Promise.all([
         repo().getProject(projectId), repo().getClips(projectId), repo().getTracks(projectId),
         repo().getTasks(projectId), repo().getLanes(projectId),
      ]);
      const found = clips.find((c) => c.id === clipId);
      if (!found) return null;
      // ボードのどのセクションにタスクとして出ているか
      const linked = tasks.find((t) => t.clipId === clipId);
      return {
         project,
         clip: found,
         track: tracks.find((t) => t.id === found.trackId) ?? null,
         lane: lanes.find((l) => l.id === linked?.laneId) ?? null,
      };
   }

   // 入力欄の内容に変更があれば保存する。名前は空でもよい
   function commit() {
      if (!clip || !el) return;
      const patch = {};
      const name = el.name.value.trim();
      if (name !== clip.name) patch.name = name;
      if (el.memo.value !== clip.memo) patch.memo = el.memo.value;
      if (!Object.keys(patch).length) return;
      clip = { ...clip, ...patch }; // 同じ変更を二度保存しないように先に反映しておく
      run(actions.updateClip(projectId, clip.id, patch));
   }

   function remove() {
      const { id, name } = clip;
      clip = null; // 削除するクリップを閉じるときに保存し直さない
      close();
      run(actions.deleteClip(projectId, id).then((deleted) => showToast(`${name ? `「${name}」` : 'クリップ'}を削除しました`, {
         actionLabel: '元に戻す',
         onAction: () => run(actions.restoreClip(deleted)),
      })));
   }

   function build() {
      const field = (label, control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
      const name = h('input', {
         class: 'input drawer-title', 'aria-label': 'クリップ名', placeholder: 'クリップ名', autocomplete: 'off', onchange: commit,
      });
      const memo = h('textarea', { class: 'textarea drawer-memo', 'aria-label': '詳細', placeholder: '詳細', onchange: commit });
      const where = h('span', { class: 'drawer-lane muted' });
      const section = h('p', { class: 'drawer-linked-note' });
      const noteCount = h('span', { class: 'muted' });
      const midi = () => clipMidi(context.project, context.track, clip);
      const midiRow = h('div', { class: 'drawer-midi' },
         h('button', {
            type: 'button',
            class: 'btn',
            onclick: () => {
               const id = clip?.id;
               if (id) onOpenPianoRoll?.(id);
            },
         }, icon('piano', 14), 'ピアノロールで編集'),
         h('button', {
            type: 'button', class: 'btn btn-icon', title: '.mid を書き出す', 'aria-label': '.mid を書き出す',
            onclick: () => downloadMidi(midi()),
         }, icon('download')),
         noteCount);

      const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'クリップ詳細', tabIndex: -1 },
         h('header', { class: 'drawer-head' },
            where,
            h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '閉じる', onclick: () => close() }, icon('x'))),
         h('div', { class: 'drawer-body' },
            name,
            section,
            midiRow,
            field('詳細', memo),
            h('div', { class: 'drawer-foot clip-foot' },
               h('button', {
                  type: 'button',
                  class: 'btn',
                  onclick: () => {
                     const id = clip?.id;
                     if (id) onDuplicate?.(id);
                  },
               }, icon('copy', 14), 'クリップを複製'),
               h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'クリップを削除'))));
      const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => close() });

      document.getElementById('overlay-root').append(backdrop, panel);
      document.body.classList.add('drawer-open');
      el = { panel, backdrop, name, memo, where, section, noteCount };
   }

   // 読み込んだ内容を表示に反映する。編集中(フォーカス中)の欄は上書きしない
   function apply(loaded, { force = false } = {}) {
      context = loaded;
      clip = context.clip;
      const count = audibleNotes(clip).length;
      el.noteCount.textContent = count ? `ノート${count}個` : 'ノートなし';
      const set = (input, value) => {
         if (force || document.activeElement !== input) input.value = value;
      };
      set(el.name, clip.name);
      set(el.memo, clip.memo);
      el.where.textContent = `${context.track?.name ?? ''}・${barRange(clip)}`;
      el.section.textContent = context.lane
         ? `ボードの「${context.lane.name}」にタスクとして出ています。`
         : 'セクションマーカーの範囲の外にあるので、ボードには出ていません。';
   }

   async function open(clipId, { focusName = false } = {}) {
      commit();
      requested = clipId;
      const context = await loadContext(clipId);
      if (!context || requested !== clipId) return;
      if (!el) build();
      apply(context, { force: true });
      // 作った直後は、すぐ名前を打てるようにする
      if (focusName) el.name.focus();
      else el.panel.focus({ preventScroll: true });
      onSelectionChange?.(clipId);
   }

   function close() {
      if (!el) return;
      commit();
      const closedId = clip?.id;
      el.panel.remove();
      el.backdrop.remove();
      document.body.classList.remove('drawer-open');
      el = null;
      clip = null;
      requested = null;
      onSelectionChange?.(null);
      if (closedId) document.querySelector(`[data-focus-key="clip:${CSS.escape(closedId)}"]`)?.focus({ preventScroll: true });
   }

   async function resync() {
      if (!clip) return;
      const context = await loadContext(clip.id);
      if (!clip || !el) return;
      if (!context) {
         // 他の操作(トラックの削除など)でクリップが消えた
         clip = null;
         close();
         return;
      }
      if (context.clip.id === clip.id) apply(context);
   }

   const onKeydown = (e) => {
      if (e.key !== 'Escape' || !el || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], .menu')) return;
      close();
   };
   document.addEventListener('keydown', onKeydown);
   const unsubscribe = subscribe(() => run(resync()));

   return {
      open: (clipId, options) => run(open(clipId, options)),
      close,
      get clipId() {
         return el ? clip?.id ?? null : null;
      },
      destroy() {
         close();
         unsubscribe();
         document.removeEventListener('keydown', onKeydown);
      },
   };
}
