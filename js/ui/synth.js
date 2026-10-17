// ブラウザの中の音源。設定画面で選んだ SoundFont(.sf2 / .sf3)か DLS(.dls)を、spessasynth_lib で鳴らす。
// spessasynth_lib は CDN から版を固定して、使うときに読む(画面の初回表示を重くしないため)。
// AudioContext とシンセは、ページの中で1つだけ作って使い回す(画面を行き来しても音源を読み直さない)。
//
// 外部の MIDI 音源(Web MIDI)は使わない。Windows の Microsoft GS Wavetable Synth はブラウザが Web MIDI から
// 除外していて鳴らせないが、同じ音色の gm.dls を音源として選べば、同じ音で鳴る。
//
// 再生は「少し先までを時刻付きで予約する」方式。25ms ごとに、150ms 先までのイベントを AudioContext の時刻付きで送る。
// タイマーの揺れが音のタイミングに出ず、停止したときに先の音まで予約してしまうこともない。

import { secondsToTicks, ticksToSeconds } from '../domain/midi.js';
import { loadSoundFont, removeSoundFont, saveSoundFont } from '../store/soundFontStore.js';

const LIB_URL = 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/+esm';
const PROCESSOR_URL = 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/dist/spessasynth_processor.min.js';
const LOOKAHEAD = 0.15; // 秒
const INTERVAL_MS = 25;
const START_DELAY = 0.08; // 音色の切り替えを先に届けるための間(秒)
const PREVIEW = 0.25; // 試し弾きの長さ(秒)

/** Windows で MSGS と同じ音色を持つファイル。ブラウザからは自動では読めないので、選ぶときの案内に使う。 */
export const WINDOWS_GM_DLS = 'C:\\Windows\\System32\\drivers\\gm.dls';
export const isWindows = () => /Windows/i.test(navigator.userAgentData?.platform ?? navigator.userAgent);

/** 音源が選ばれていない。 */
export class NoSoundFontError extends Error {
   constructor() {
      super(isWindows()
         ? `音源が設定されていません。設定画面で ${WINDOWS_GM_DLS}(MSGS と同じ音)か、手持ちの SoundFont を選んでください`
         : '音源が設定されていません。設定画面で手持ちの SoundFont(.sf2)か DLS を選んでください');
      this.name = 'NoSoundFontError';
   }
}

let ctx = null;
let synth = null;
let preparing = null;
// 保存している音源の名前とサイズ。まだ調べていなければ undefined、なければ null
let source;

const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

/** 変化(音源の読み込み・入れ替え、再生の開始・停止)を受け取る。解除する関数を返す。 */
export function onSynthChange(fn) {
   listeners.add(fn);
   return () => listeners.delete(fn);
}

/** 保存している音源({ name, size })。まだ調べていなければ undefined、なければ null。 */
export const soundSource = () => source;
export const isSynthReady = () => synth !== null;
export const isSynthLoading = () => preparing !== null && synth === null;

/** 保存している音源を調べ直す(表示用。音源は読み込まない)。 */
export async function refreshSoundSource() {
   const stored = await loadSoundFont();
   source = stored && { name: stored.name, size: stored.size };
   emit();
   return source;
}

/**
 * 音源を使えるようにする。何度呼んでも読み込みは1回だけ。
 * 音源が選ばれていなければ NoSoundFontError、読めない形式なら spessasynth_lib のエラーで失敗する。
 */
export function prepareSynth() {
   preparing ??= (async () => {
      const stored = await loadSoundFont();
      source = stored && { name: stored.name, size: stored.size };
      if (!stored) throw new NoSoundFontError();
      const { WorkletSynthesizer } = await import(LIB_URL);
      ctx ??= new AudioContext({ latencyHint: 'interactive' });
      // 同じ URL を2回足しても、2回目は読み直さない(入れ替えでシンセを作り直すとき)
      await ctx.audioWorklet.addModule(PROCESSOR_URL);
      const created = new WorkletSynthesizer(ctx);
      created.connect(ctx.destination);
      try {
         await created.soundBankManager.addSoundBank(await stored.blob.arrayBuffer(), 'main');
         await created.isReady;
      } catch (error) {
         created.destroy();
         throw new Error(`「${stored.name}」を音源として読み込めませんでした(${error?.message ?? error})`);
      }
      synth = created;
      emit();
      return created;
   })().catch((error) => {
      preparing = null;
      emit();
      throw error;
   });
   return preparing;
}

// 作ったシンセを捨てる(音源を入れ替えたとき)。次に使うときに読み直す
function discard() {
   stop();
   synth?.destroy();
   synth = null;
   preparing = null;
}

/** 選んだファイルを音源として保存し、読み込む。読めなければ保存したものを消して失敗する。 */
export async function setSoundFont(file) {
   discard();
   await saveSoundFont(file);
   try {
      await prepareSynth();
   } catch (error) {
      await removeSoundFont();
      source = null;
      emit();
      throw error;
   }
}

export async function clearSoundFont() {
   discard();
   await removeSoundFont();
   source = null;
   emit();
}

// ユーザーの操作の中で呼ぶ(ブラウザは、操作なしに音を出させない)
async function ready() {
   const s = await prepareSynth();
   await ctx.resume();
   return s;
}

// ---- 試し弾き ----

/**
 * 1音だけ短く鳴らす(ピアノロールでノートを置いたときなど)。音源がまだ読み込まれていなければ、
 * 読み込みを始めるだけで鳴らさない(読み込みに時間が掛かるので、遅れて鳴らすより鳴らさない方が分かりやすい)。
 * 再生中は鳴らさない。
 * @param {number[][]} setup 先に送るメッセージ(音色など)
 */
export function previewNote(setup, channel, pitch, velocity = 100) {
   if (playing) return;
   if (!synth) {
      prepareSynth().catch(() => {});
      return;
   }
   ctx.resume();
   for (const data of setup) synth.sendMessage(data);
   synth.noteOn(channel, pitch, velocity);
   synth.noteOff(channel, pitch, { time: ctx.currentTime + PREVIEW });
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
   const s = await ready();
   for (const data of setup) s.sendMessage(data);
   const startAt = ctx.currentTime + START_DELAY;
   const state = {
      synth: s,
      bpm,
      fromTick,
      startAt,
      // 再生位置より前で始まる音は鳴らさない(途中から鳴らしたときに、頭の切れた音を出さない)
      events: events.filter((e) => ((e.data[0] & 0xf0) === 0x90 ? e.tick >= fromTick : e.tick > fromTick)),
      index: 0,
      sounding: new Map(), // 鳴らした(予約した)まま止めていない音。'チャンネル:高さ' → [チャンネル, 高さ]
      lastSentAt: startAt,
      onEnd,
      timer: null,
   };
   playing = state;
   state.timer = setInterval(() => pump(state), INTERVAL_MS);
   pump(state);
   emit();
}

const timeOf = (state, tick) => state.startAt + ticksToSeconds(tick - state.fromTick, state.bpm);

function pump(state) {
   if (playing !== state) return;
   const now = ctx.currentTime;
   const horizon = now + LOOKAHEAD;
   const { events, sounding } = state;
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
      state.synth.sendMessage(event.data, 0, { time: Math.max(at, now) });
      if (kind === 0x90) sounding.set(key, [event.data[0] & 0x0f, event.data[1]]);
      else sounding.delete(key);
      state.lastSentAt = Math.max(state.lastSentAt, at);
      state.index++;
   }
   if (state.index >= events.length && now > state.lastSentAt + 0.1) {
      const { onEnd } = state;
      stop();
      onEnd?.();
   }
}

/** いまの再生位置(tick)。止まっていれば null。音が実際に出るまでの遅れ(outputLatency)を差し引く。 */
export function playbackTick() {
   if (!playing) return null;
   const elapsed = Math.max(0, ctx.currentTime - (ctx.outputLatency || 0) - playing.startAt);
   return playing.fromTick + secondsToTicks(elapsed, playing.bpm);
}

export function stop() {
   const state = playing;
   if (!state) return;
   playing = null;
   clearInterval(state.timer);
   // 予約済みでまだ鳴っていない音もあるので、最後に予約した時刻の直後にも止める
   const at = Math.max(ctx.currentTime, state.lastSentAt) + 0.001;
   for (const [channel, pitch] of state.sounding.values()) state.synth.noteOff(channel, pitch, { time: at });
   for (let ch = 0; ch < 16; ch++) {
      state.synth.sendMessage([0xb0 | ch, 120, 0], 0, { time: at }); // オールサウンドオフ
      state.synth.sendMessage([0xb0 | ch, 123, 0], 0, { time: at }); // オールノートオフ
   }
   state.synth.stopAll(true);
   emit();
}
