// 作業タイマー。進行中のクリップ(連動タスクが作業中のもの)を1つずつ「いまの作業対象」にして、決めた時間で次へ回す。
// 作業にメリハリをつけるためのもので、アレンジ画面のツールバーから始める(PC だけ。スマホ幅では出さない)。
// 順番は domain/work.js。
//
// 状態はこのモジュールに持つ(画面ではなく)。ボードへ切り替えてタスクを完了にしているあいだも数え続けるため。
// どこにも保存せず、再読み込みで消える。1クリップあたりの時間(分)だけを、このブラウザの localStorage に覚えておく。
//
// 時間切れは気づきにくい(DAW を前に出して作業していると、ブラウザは見えていない)ので、いくつかの方法を重ねて知らせる。
// - 短いチャイムを鳴らす(シンセとは別の AudioContext。始めるボタンの操作の中で作り、自動再生の制限に掛からないようにする)
// - ブラウザにフォーカスがなければ、OS の通知を出す(始めるときに許可を求める。断られたら出さない)
// - ツールバーの表示を、次にこのページを触るまで点滅させる
// - タブのタイトルに残り時間と作業対象を出す
// 作業対象のタスクを完了(や未着手)にしたり、クリップを消したりしたときは、知らせずにすぐ次へ進み、時間を数え直す。

import { nextWork, workQueue } from '../domain/work.js';
import { repo, subscribe } from '../state.js';
import { formDialog } from './components/dialog.js';
import { h, icon } from './components/dom.js';
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

/**
 * 動いているタイマー。止まっていれば null。
 * @type {{ projectId: string, minutes: number, current: object, endsAt: number, alert: boolean } | null}
 */
let state = null;
let ticker = null;
let unsubscribeData = null;
let audio = null; // チャイム用の AudioContext
let baseTitle = '';
const listeners = new Set();

export const workTimer = () => state;

/** 状態が変わるたび(1秒ごとの残り時間も)に呼ぶ。 @returns {() => void} 購読解除 */
export function onWorkTimerChange(listener) {
   listeners.add(listener);
   return () => listeners.delete(listener);
}

function emit() {
   updateTitle();
   for (const listener of listeners) listener(state);
}

async function loadQueue(projectId) {
   const [tracks, clips, tasks, markers] = await Promise.all([
      repo().getTracks(projectId),
      repo().getClips(projectId),
      repo().getTasks(projectId),
      repo().getMarkers(projectId),
   ]);
   return workQueue({ tracks, clips, tasks, markers });
}

const remainingMs = () => Math.max(0, state.endsAt - Date.now());

// 「12:05」「1:02:09」
export function formatRemaining(ms) {
   const total = Math.ceil(ms / 1000);
   const pad = (n) => String(n).padStart(2, '0');
   const hours = Math.floor(total / 3600);
   const minutes = Math.floor(total / 60) % 60;
   const seconds = total % 60;
   return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function updateTitle() {
   document.title = state ? `${formatRemaining(remainingMs())} ${state.current.title} - ${baseTitle}` : baseTitle;
}

/**
 * 時間(分)を聞いてから始める。進行中のクリップがなければ、そう知らせて始めない。
 * チャイムと通知の許可は、ボタンを押した操作の中で用意する(あとからでは、ブラウザが許さない)。
 */
export async function startWorkTimer(projectId) {
   if (!audio) audio = new AudioContext();
   audio.resume().catch(() => {});
   const queue = await loadQueue(projectId);
   if (!queue.length) {
      showToast('進行中のクリップがありません。クリップの詳細でステータスを「作業中」にすると、作業タイマーの対象になります');
      return;
   }
   const values = await formDialog({
      title: '作業タイマー',
      message: `進行中のクリップ(${queue.length}件)を曲の頭から1つずつ作業対象にして、決めた時間で次へ回します。時間切れはチャイムと通知で知らせます。`,
      submitLabel: '始める',
      fields: [{ name: 'minutes', label: `1クリップあたりの時間(分。1〜${MAX_WORK_MINUTES})`, type: 'number', value: String(loadMinutes()), required: true }],
   });
   if (!values) return;
   const minutes = Math.round(Number(values.minutes));
   if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WORK_MINUTES) {
      showToast(`時間は1〜${MAX_WORK_MINUTES}分で入れてください`);
      return;
   }
   saveMinutes(minutes);
   if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
   }
   // ダイアログを開いている間に変わったかもしれないので、読み直してから始める
   const first = nextWork(await loadQueue(projectId), null);
   if (!first) return;
   if (!state) baseTitle = document.title;
   stopTicking();
   state = { projectId, minutes, current: first, endsAt: Date.now() + minutes * 60 * 1000, alert: false };
   ticker = setInterval(tick, 1000);
   unsubscribeData = subscribe((change) => {
      if (change.projectId === projectId) checkCurrent().catch(reportError);
   });
   emit();
}

export function stopWorkTimer() {
   if (!state) return;
   stopTicking();
   state = null;
   emit();
}

function stopTicking() {
   clearInterval(ticker);
   unsubscribeData?.();
   unsubscribeData = null;
}

/** 時間を待たずに次の作業対象へ進む。 */
export function skipWork() {
   advance({ alert: false }).catch(reportError);
}

/** 点滅を止める(ページを触ったら呼ぶ)。 */
export function acknowledgeWork() {
   if (!state?.alert) return;
   state = { ...state, alert: false };
   emit();
}

function tick() {
   if (!state) return;
   if (remainingMs() > 0) emit();
   else advance({ alert: true }).catch(reportError);
}

// 次の作業対象にして、時間を数え直す。対象がなくなっていたら止める
async function advance({ alert }) {
   const { projectId, current } = state;
   const next = nextWork(await loadQueue(projectId), current);
   if (state?.current !== current) return; // 読んでいる間に止められた・ほかの理由で先に進んだ
   if (!next) {
      stopWorkTimer();
      showToast('進行中のクリップがなくなったので、作業タイマーを止めました');
      return;
   }
   state = { ...state, current: next, endsAt: Date.now() + state.minutes * 60 * 1000, alert: alert || state.alert };
   if (alert) notifyNext(next);
   emit();
}

// 作業対象のタスクが作業中でなくなった(完了にした、など)・クリップが消えたら、すぐ次へ。
// 名前が変わっただけなら、表示だけを直す
async function checkCurrent() {
   const { projectId, current } = state;
   const queue = await loadQueue(projectId);
   if (!state || state.projectId !== projectId || state.current !== current) return;
   const same = queue.find((w) => w.clipId === current.clipId);
   if (!same) {
      await advance({ alert: false });
      return;
   }
   if (same.title !== current.title || same.startBar !== current.startBar || same.trackIndex !== current.trackIndex) {
      state = { ...state, current: same };
      emit();
   }
}

function notifyNext(next) {
   chime();
   if (document.hasFocus() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
   try {
      const notification = new Notification('次の作業', { body: next.title, tag: 'dtm-proj-work', renotify: true });
      notification.onclick = () => {
         window.focus();
         notification.close();
      };
   } catch {
      // 通知を出せない環境では、チャイムと点滅だけで知らせる
   }
}

// 上がっていく2音(ポーン、ピーン)。音源(SoundFont)が選ばれていなくても鳴るよう、オシレーターで作る
function chime() {
   if (!audio) return;
   audio.resume().catch(() => {});
   const now = audio.currentTime;
   [[880, 0], [1318.5, 0.18]].forEach(([frequency, delay]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.2);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 1.3);
   });
}

/**
 * アレンジ画面のツールバーに出す部品。止まっていれば「作業タイマー」のボタン、動いていれば作業対象と残り時間。
 * el は再描画のたびにツールバーへ入れ直して使い回す(1秒ごとの更新は、この中だけで行う)。
 * @param {string} projectId
 * @param {{ onOpenClip: (clipId: string) => void }} callbacks 作業対象の名前を押したとき
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createWorkTimerView(projectId, { onOpenClip }) {
   const el = h('div', { class: 'work-timer' });
   const startButton = h('button', {
      type: 'button',
      class: 'btn',
      title: '進行中のクリップを1つずつ、決めた時間で回して作業する',
      dataset: { focusKey: 'work-start' },
      onclick: () => startWorkTimer(projectId).catch(reportError),
   }, icon('timer', 14), '作業タイマー');
   const name = h('button', {
      type: 'button',
      class: 'work-timer-name',
      onclick: () => {
         acknowledgeWork();
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
         onclick: () => {
            acknowledgeWork();
            skipWork();
         },
      }, icon('skip-forward', 14)),
      h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': '作業タイマーを止める',
         title: '作業タイマーを止める',
         dataset: { focusKey: 'work-stop' },
         onclick: () => stopWorkTimer(),
      }, icon('square', 14)));

   let shown = null; // いま出している中身(startButton か running)
   function update() {
      // ほかのプロジェクトで動いているタイマーは、ここには出さない(始めれば、そちらは止まってこちらに替わる)
      const mine = state?.projectId === projectId ? state : null;
      const content = mine ? running : startButton;
      if (shown !== content) {
         el.replaceChildren(content);
         shown = content;
      }
      if (!mine) return;
      const ms = remainingMs();
      name.textContent = mine.current.title;
      name.title = `${mine.current.title}(押すとクリップを開く)`;
      remaining.textContent = formatRemaining(ms);
      running.classList.toggle('is-ending', ms <= ENDING_MS);
      running.classList.toggle('is-alert', mine.alert);
   }

   // 時間切れの点滅は、次にこのページを触ったら止める(DAW から戻ってきて、目に入ったあと)
   const onTouch = () => acknowledgeWork();
   document.addEventListener('pointerdown', onTouch, true);
   document.addEventListener('keydown', onTouch, true);
   const unsubscribe = onWorkTimerChange(update);
   update();
   return {
      el,
      destroy() {
         unsubscribe();
         document.removeEventListener('pointerdown', onTouch, true);
         document.removeEventListener('keydown', onTouch, true);
      },
   };
}
