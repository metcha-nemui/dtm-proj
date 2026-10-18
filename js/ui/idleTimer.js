// 「最後に編集してから」の経過時間。再生してばかりで手が止まっていることに気づくための表示で、アレンジ画面のツールバーに出す。
// 数えるのはアレンジ画面を開いている間だけで、開くたびに0から始める(この端末の、いま開いている画面だけを見る)。
// 編集は、そのプロジェクトへの保存(actions.js の notify({ projectId }))で数える。ミュート・ソロや音量も保存なので編集に含める。
// 経過時間はどこにも保存しない。表示し始める時間(分)だけを、このブラウザの localStorage に覚えておく。

import { subscribe } from '../state.js';
import { h, icon } from './components/dom.js';

const MINUTES_KEY = 'dtm-proj:idle-minutes';
export const DEFAULT_IDLE_MINUTES = 2;
export const MAX_IDLE_MINUTES = 120;

/** 表示し始めるまでの分数。0 なら表示しない。 */
export function loadIdleMinutes() {
   try {
      const value = localStorage.getItem(MINUTES_KEY);
      const minutes = Number(value);
      return value !== null && Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_IDLE_MINUTES ? minutes : DEFAULT_IDLE_MINUTES;
   } catch {
      return DEFAULT_IDLE_MINUTES; // localStorage を使えない環境では、既定の値で数える
   }
}

export function saveIdleMinutes(minutes) {
   try {
      if (minutes === DEFAULT_IDLE_MINUTES) localStorage.removeItem(MINUTES_KEY);
      else localStorage.setItem(MINUTES_KEY, String(minutes));
   } catch {
      // 保存できなければ、次に開いたときは既定の値に戻る
   }
}

// 「3:05」「1:02:09」
function formatElapsed(ms) {
   const total = Math.floor(ms / 1000);
   const pad = (n) => String(n).padStart(2, '0');
   const h = Math.floor(total / 3600);
   const m = Math.floor(total / 60) % 60;
   const s = total % 60;
   return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 経過時間の表示を作る。el は再描画のたびにツールバーへ入れ直して使い回す(作り直すと数え直しになるため)。
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createIdleTimer(projectId) {
   // 設定は開いたときの値を使う(設定画面とアレンジ画面は同時に開かない)
   const threshold = loadIdleMinutes() * 60 * 1000;
   const label = h('span');
   const el = h('span', { class: 'idle-timer', hidden: true, role: 'status', title: '最後に編集してからの経過時間' },
      icon('hourglass', 14), label);
   let lastEdit = Date.now();

   function tick() {
      const elapsed = Date.now() - lastEdit;
      const show = threshold > 0 && elapsed >= threshold;
      el.hidden = !show;
      if (show) label.textContent = `編集から ${formatElapsed(elapsed)}`;
   }

   // projectId のない通知(接続の回復、インポート)は編集ではない
   const unsubscribe = subscribe((change) => {
      if (change.projectId !== projectId) return;
      lastEdit = Date.now();
      tick();
   });
   const timer = threshold > 0 ? setInterval(tick, 1000) : null;
   return {
      el,
      destroy() {
         unsubscribe();
         clearInterval(timer);
      },
   };
}
