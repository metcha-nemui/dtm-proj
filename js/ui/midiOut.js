// Web MIDI での出力と再生。音は Web MIDI に出ている MIDI 音源や仮想 MIDI ポートに送り、自前では鳴らさない。
// Chrome と Edge で動く(Web MIDI は localhost か HTTPS でしか使えない)。
// ただし Microsoft GS Wavetable Synth は、ブラウザが Web MIDI の一覧から除外しているので使えない。
//
// 再生は「少し先までを時刻付きで予約する」方式。25ms ごとに、150ms 先までのイベントを output.send(data, 時刻) で送る。
// タイマーの揺れが音のタイミングに出ないようにするため。MSGS は音が出るまでが遅いので、
// 再生位置の表示と実際の音は少しずれる(音どうしのタイミングは揃う)。

import { ticksToSeconds, secondsToTicks } from '../domain/midi.js';

const OUTPUT_KEY = 'dtm-proj:midi-output';
const LOOKAHEAD_MS = 150;
const INTERVAL_MS = 25;
const START_DELAY_MS = 60; // 音色の切り替えを先に届けるための間
const PREVIEW_MS = 250;

let access = null;
let accessPromise = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

/** 変化(出力の一覧、選んでいる出力、再生の開始・停止)を受け取る。解除する関数を返す。 */
export function onMidiChange(fn) {
   listeners.add(fn);
   return () => listeners.delete(fn);
}

export const midiSupported = () => typeof navigator.requestMIDIAccess === 'function';
export const hasMidiAccess = () => access !== null;

/** MIDI の使用を求める(初回はブラウザが許可を尋ねる)。 */
export function requestMidiAccess() {
   if (!midiSupported()) return Promise.reject(new Error('このブラウザは Web MIDI に対応していません(Chrome か Edge で開いてください)'));
   accessPromise ??= navigator.requestMIDIAccess().then((a) => {
      access = a;
      a.addEventListener('statechange', emit);
      emit();
      return a;
   }, () => {
      accessPromise = null;
      throw new Error('MIDI の使用が許可されませんでした(アドレスバーのサイト設定で許可できます)');
   });
   return accessPromise;
}

/** すでに許可されていれば、尋ねずに使えるようにしておく(出力の一覧を最初から出すため)。 */
export async function restoreMidiAccess() {
   if (!midiSupported() || access) return;
   try {
      const status = await navigator.permissions.query({ name: 'midi' });
      if (status.state === 'granted') await requestMidiAccess();
   } catch {
      // permissions で midi を尋ねられないブラウザでは、再生を押したときに求める
   }
}

function readSaved() {
   try {
      return localStorage.getItem(OUTPUT_KEY);
   } catch {
      return null;
   }
}

/** 使える出力の一覧。 */
export function midiOutputs() {
   return access ? [...access.outputs.values()].filter((o) => o.state !== 'disconnected') : [];
}

/** 使う出力。選んだものがなければ MSGS、それもなければ最初のもの。 */
export function currentOutput() {
   const list = midiOutputs();
   const saved = readSaved();
   return list.find((o) => o.id === saved) ?? list.find((o) => /GS Wavetable/i.test(o.name)) ?? list[0] ?? null;
}

export function selectOutput(id) {
   stop();
   try {
      localStorage.setItem(OUTPUT_KEY, id);
   } catch {
      // 覚えられなくても、この画面の間は既定の選び方に戻るだけ
   }
   emit();
}

async function readyOutput() {
   await requestMidiAccess();
   const output = currentOutput();
   // Chrome / Edge / Firefox は Microsoft GS Wavetable Synth を Web MIDI に出さない(ブラウザ側で除外している)。
   // ほかの MIDI 音源(VirtualMIDISynth など)か、仮想 MIDI ポート(loopMIDI など)経由の DAW が要る
   if (!output) throw new Error('MIDI の出力先が見つかりません(ブラウザからは Microsoft GS Wavetable Synth を使えません。ほかの MIDI 音源か仮想 MIDI ポートを用意してください)');
   return output;
}

// ---- 試し弾き ----

/**
 * 1音だけ短く鳴らす(ピアノロールでノートを置いたときなど)。まだ許可を得ていなければ鳴らさない
 * (ノートを置くたびに許可を尋ねないため)。再生中は鳴らさない。
 * @param {number[][]} setup 先に送るメッセージ(音色など)
 */
export function previewNote(setup, channel, pitch, velocity = 100) {
   if (playing || !access) return;
   const output = currentOutput();
   if (!output) return;
   const now = performance.now();
   for (const data of setup) output.send(data, now);
   output.send([0x90 | channel, pitch, velocity], now);
   output.send([0x80 | channel, pitch, 0], now + PREVIEW_MS);
}

// ---- 再生 ----

let playing = null;

export const isPlaying = () => playing !== null;

/**
 * 再生を始める(再生中なら、止めてから始め直す)。
 * @param {object} options
 * @param {number} options.bpm
 * @param {number[][]} options.setup 頭で送るメッセージ(チャンネルごとの音色・音量・パン)
 * @param {{ tick: number, data: number[] }[]} options.events noteEvents の結果
 * @param {number} options.fromTick ここから鳴らす(曲の頭が 0)
 * @param {() => void} [options.onEnd] 最後まで鳴らし終えたとき
 */
export async function play({ bpm, setup, events, fromTick, onEnd }) {
   stop();
   const output = await readyOutput();
   const startAt = performance.now() + START_DELAY_MS;
   for (const data of setup) output.send(data, performance.now());
   const state = {
      output,
      bpm,
      fromTick,
      startAt,
      events: [],
      index: 0,
      sounding: new Map(), // 鳴らした(予約した)まま止めていない音。'チャンネル:高さ' → [チャンネル, 高さ]
      lastSentAt: startAt,
      onEnd,
      timer: null,
   };
   // 再生位置より前で始まる音は鳴らさない(途中から鳴らしたときに、頭の切れた音を出さない)
   state.events = events.filter((e) => ((e.data[0] & 0xf0) === 0x90 ? e.tick >= fromTick : e.tick > fromTick));
   playing = state;
   state.timer = setInterval(() => pump(state), INTERVAL_MS);
   pump(state);
   emit();
}

const timeOf = (state, tick) => state.startAt + ticksToSeconds(tick - state.fromTick, state.bpm) * 1000;

function pump(state) {
   if (playing !== state) return;
   const horizon = performance.now() + LOOKAHEAD_MS;
   const { output, events, sounding } = state;
   while (state.index < events.length) {
      const event = events[state.index];
      const at = timeOf(state, event.tick);
      if (at > horizon) break;
      const kind = event.data[0] & 0xf0;
      const key = `${event.data[0] & 0x0f}:${event.data[1]}`;
      if (kind === 0x80 && !sounding.has(key)) {
         state.index++;
         continue; // 鳴らしていない音(途中から再生したときの、前の音の終わり)
      }
      output.send(event.data, Math.max(at, performance.now()));
      if (kind === 0x90) sounding.set(key, [event.data[0] & 0x0f, event.data[1]]);
      else sounding.delete(key);
      state.lastSentAt = Math.max(state.lastSentAt, at);
      state.index++;
   }
   if (state.index >= events.length && performance.now() > state.lastSentAt + 100) {
      const { onEnd } = state;
      stop();
      onEnd?.();
   }
}

/** いまの再生位置(tick)。止まっていれば null。 */
export function playbackTick() {
   if (!playing) return null;
   const elapsed = Math.max(0, performance.now() - playing.startAt) / 1000;
   return playing.fromTick + secondsToTicks(elapsed, playing.bpm);
}

// 鳴っている(予約した)音を止める。予約済みでまだ鳴っていない音もあるので、最後に予約した時刻より後に送る
function silence(state) {
   const at = Math.max(performance.now(), state.lastSentAt) + 1;
   for (const [channel, pitch] of state.sounding.values()) state.output.send([0x80 | channel, pitch, 0], at);
   state.sounding.clear();
}

export function stop() {
   const state = playing;
   if (!state) return;
   playing = null;
   clearInterval(state.timer);
   state.output.clear?.(); // 予約を取り消せるブラウザでは取り消す
   silence(state);
   // 念のため、全チャンネルにオールノートオフ
   const at = Math.max(performance.now(), state.lastSentAt) + 2;
   for (let ch = 0; ch < 16; ch++) state.output.send([0xb0 | ch, 123, 0], at);
   emit();
}
