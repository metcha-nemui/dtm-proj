// 作業タイマー。進行中のクリップ(連動タスクが作業中のもの)を1つずつ「いまの作業対象」にして、決めた時間で次へ進める。
// 作業にメリハリをつけるためのもので、アレンジ画面のツールバーに出す(PC だけ。スマホ幅では出さない)。
// 順番は始めるときに一覧で入れ替えられる(domain/work.js)。最後まで行ったら止まる。
//
// アレンジ画面を開いている間だけ動き、ほかの画面へ移ると止まる。どこにも保存しない。
// 1クリップあたりの時間(分)だけを、このブラウザの localStorage に覚えておく。
//
// 時間切れは気づきにくい(DAW を前に出して作業していると、ブラウザは見えていない)ので、いくつかの方法を重ねて知らせる。
// - ブラウザにフォーカスがなければ、OS の通知を出す(始めるときに許可を求める。断られたら出さない)
// - ツールバーの表示を、次にこのページを触るまで点滅させる
// - タブのタイトルに残り時間と作業対象を出す
// 作業対象のタスクを完了(や未着手)にしたり、クリップを消したりしたときは、知らせずにすぐ次へ進み、時間を数え直す。

import { nextWork, workQueue } from '../domain/work.js';
import { repo, subscribe } from '../state.js';
import { formDialog } from './components/dialog.js';
import { h, icon } from './components/dom.js';
import { createSortable } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';

const MINUTES_KEY = 'dtm-proj:work-minutes';
export const DEFAULT_WORK_MINUTES = 15;
export const MAX_WORK_MINUTES = 180;
const ENDING_MS = 60 * 1000; // 残りがこれより少なくなったら、表示の色を変えて終わりが近いことを見せる

function loadMinutes() {
   try {
      const minutes = Number(localStorage.getItem(MINUTES_KEY));
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_WORK_MINUTES ? minutes : DEFAULT_WORK_MINUTES;
   } catch {
      return DEFAULT_WORK_MINUTES;
   }
}

function saveMinutes(minutes) {
   try {
      localStorage.setItem(MINUTES_KEY, String(minutes));
   } catch {
      // 保存できなければ、次は既定の値から始める
   }
}

// 「12:05」「1:02:09」
function formatRemaining(ms) {
   const total = Math.ceil(ms / 1000);
   const pad = (n) => String(n).padStart(2, '0');
   const hours = Math.floor(total / 3600);
   const minutes = Math.floor(total / 60) % 60;
   const seconds = total % 60;
   return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// 作業する順を決める一覧。ドラッグで入れ替える。value は上からの clipId の並び
function orderList(id, queue) {
   const list = h('ol', { id, class: 'work-order' }, queue.map((w) => h('li', { class: 'work-order-item', dataset: { clipId: w.clipId } },
      icon('grip-vertical', 14),
      h('span', { class: 'work-order-title' }, w.title))));
   // ダイアログは最前面(top layer)にあるので、掴んだ要素の複製を body に出すと隠れて見えない。一覧の中に出す
   createSortable(list, { fallbackOnBody: false });
   Object.defineProperty(list, 'value', { get: () => [...list.children].map((li) => li.dataset.clipId) });
   return list;
}

// OS の通知。ブラウザが前に出ていれば(点滅とタイトルで分かるので)出さない
function notify(title, body) {
   if (document.hasFocus() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
   try {
      const notification = new Notification(title, { body, tag: 'dtm-proj-work', renotify: true });
      notification.onclick = () => {
         window.focus();
         notification.close();
      };
   } catch {
      // 通知を出せない環境では、点滅とタイトルだけで知らせる
   }
}

/**
 * ツールバーに出す部品。止まっていれば「作業タイマー」のボタン、動いていれば作業対象と残り時間。
 * el は再描画のたびにツールバーへ入れ直して使い回す(1秒ごとの更新は、この中だけで行う)。
 * @param {string} projectId
 * @param {{ onOpenClip: (clipId: string) => void }} callbacks 作業対象の名前を押したとき
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createWorkTimer(projectId, { onOpenClip }) {
   /**
    * 動いているタイマー。止まっていれば null。
    * @type {{ minutes: number, order: string[], current: object, endsAt: number, alert: boolean } | null}
    */
   let state = null;
   let ticker = null;
   let unsubscribeData = null;
   let alive = true;
   const baseTitle = document.title;

   const loadQueue = async () => {
      const [tracks, clips, tasks, markers] = await Promise.all([
         repo().getTracks(projectId),
         repo().getClips(projectId),
         repo().getTasks(projectId),
         repo().getMarkers(projectId),
      ]);
      return workQueue({ tracks, clips, tasks, markers });
   };
   const remainingMs = () => Math.max(0, state.endsAt - Date.now());

   // 時間と順番を聞いてから始める。進行中のクリップがなければ、そう知らせて始めない
   async function start() {
      const queue = await loadQueue();
      if (!queue.length) {
         showToast('進行中のクリップがありません。クリップの詳細でステータスを「作業中」にすると、作業タイマーの対象になります');
         return;
      }
      const values = await formDialog({
         title: '作業タイマー',
         message: '進行中のクリップを、上から1つずつ作業対象にして、決めた時間で次へ進めます。最後まで行ったら止まります。',
         submitLabel: '始める',
         fields: [
            { name: 'minutes', label: `1クリップあたりの時間(分。1〜${MAX_WORK_MINUTES})`, type: 'number', value: String(loadMinutes()), required: true },
            { name: 'order', label: `作業する順(${queue.length}件。ドラッグで入れ替える)`, type: 'custom', render: (id) => orderList(id, queue) },
         ],
      });
      if (!values || !alive) return;
      const minutes = Math.round(Number(values.minutes));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WORK_MINUTES) {
         showToast(`時間は1〜${MAX_WORK_MINUTES}分で入れてください`);
         return;
      }
      saveMinutes(minutes);
      // 許可を求めるのは、ボタンを押した操作の続きのうちに(あとからでは、ブラウザが許さない)
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
         Notification.requestPermission().catch(() => {});
      }
      // ダイアログを開いている間に変わったかもしれないので、読み直してから始める
      const first = nextWork(values.order, await loadQueue());
      if (!first || !alive) return;
      stop();
      state = { minutes, order: values.order, current: first, endsAt: Date.now() + minutes * 60 * 1000, alert: false };
      ticker = setInterval(tick, 1000);
      unsubscribeData = subscribe((change) => {
         if (change.projectId === projectId) checkCurrent().catch(reportError);
      });
      update();
   }

   function stop() {
      clearInterval(ticker);
      unsubscribeData?.();
      unsubscribeData = null;
      state = null;
      update();
   }

   function tick() {
      if (!state) return;
      if (remainingMs() > 0) update();
      else advance({ alert: true }).catch(reportError);
   }

   // 次の作業対象にして、時間を数え直す。最後まで行ったら止める
   async function advance({ alert }) {
      const { current } = state;
      const next = nextWork(state.order, await loadQueue(), current.clipId);
      if (state?.current !== current) return; // 読んでいる間に止められた・ほかの理由で先に進んだ
      if (!next) {
         stop();
         if (alert) notify('作業タイマー', 'すべての作業の時間が終わりました');
         showToast('すべての作業を終えたので、作業タイマーを止めました');
         return;
      }
      state = { ...state, current: next, endsAt: Date.now() + state.minutes * 60 * 1000, alert: alert || state.alert };
      if (alert) notify('次の作業', next.title);
      update();
   }

   // 作業対象のタスクが作業中でなくなった(完了にした、など)・クリップが消えたら、すぐ次へ。
   // 名前が変わっただけなら、表示だけを直す
   async function checkCurrent() {
      const { current } = state;
      const same = (await loadQueue()).find((w) => w.clipId === current.clipId);
      if (state?.current !== current) return;
      if (!same) {
         await advance({ alert: false });
      } else if (same.title !== current.title) {
         state = { ...state, current: same };
         update();
      }
   }

   // 点滅を止める(ページを触ったら呼ぶ)
   function acknowledge() {
      if (!state?.alert) return;
      state = { ...state, alert: false };
      update();
   }

   const el = h('div', { class: 'work-timer' });
   const startButton = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      title: '作業タイマー(進行中のクリップを1つずつ、決めた時間で区切って作業する)',
      'aria-label': '作業タイマー',
      dataset: { focusKey: 'work-start' },
      onclick: () => start().catch(reportError),
   }, icon('timer'));
   const name = h('button', {
      type: 'button',
      class: 'work-timer-name',
      onclick: () => {
         if (state) onOpenClip(state.current.clipId);
      },
   });
   const remaining = h('span', { class: 'work-timer-remaining' });
   const running = h('div', { class: 'work-timer-running', role: 'timer' },
      icon('timer', 14),
      name,
      remaining,
      h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': '次の作業へ',
         title: '次の作業へ(時間を数え直す)',
         dataset: { focusKey: 'work-skip' },
         onclick: () => advance({ alert: false }).catch(reportError),
      }, icon('skip-forward', 14)),
      h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': '作業タイマーを止める',
         title: '作業タイマーを止める',
         dataset: { focusKey: 'work-stop' },
         onclick: () => stop(),
      }, icon('square', 14)));

   let shown = null; // いま出している中身(startButton か running)
   function update() {
      const content = state ? running : startButton;
      if (shown !== content) {
         el.replaceChildren(content);
         shown = content;
      }
      if (!state) {
         document.title = baseTitle;
         return;
      }
      const ms = remainingMs();
      name.textContent = state.current.title;
      name.title = `${state.current.title}(押すとクリップを開く)`;
      remaining.textContent = formatRemaining(ms);
      running.classList.toggle('is-ending', ms <= ENDING_MS);
      running.classList.toggle('is-alert', state.alert);
      document.title = `${formatRemaining(ms)} ${state.current.title} - ${baseTitle}`;
   }

   // 時間切れの点滅は、次にこのページを触ったら止める(DAW から戻ってきて、目に入ったあと)
   document.addEventListener('pointerdown', acknowledge, true);
   document.addEventListener('keydown', acknowledge, true);
   update();
   return {
      el,
      destroy() {
         alive = false;
         stop();
         document.removeEventListener('pointerdown', acknowledge, true);
         document.removeEventListener('keydown', acknowledge, true);
      },
   };
}
