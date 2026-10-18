// ブラウザの中の音源。設定画面で選んだ SoundFont(.sf2 / .sf3)か DLS(.dls)を、spessasynth_lib で鳴らす。
// spessasynth_lib は CDN から版を固定して、使うときに読む(画面の初回表示を重くしないため)。
// AudioContext とシンセは、ページの中で1つだけ作って使い回す(画面を行き来しても音源を読み直さない)。
//
// 外部の MIDI 音源(Web MIDI)は使わない。Windows の Microsoft GS Wavetable Synth はブラウザが Web MIDI から
// 除外していて鳴らせないが、同じ音色の gm.dls を音源として選べば、同じ音で鳴る。
//
// 再生は「少し先までを時刻付きで予約する」方式。25ms ごとに、150ms 先までのイベントを AudioContext の時刻付きで送る。
// タイマーの揺れが音のタイミングに出ず、停止したときに先の音まで予約してしまうこともない。
// ループ再生(ピアノロールのクリップの再生)では、1周分のイベントを周回ごとに長さぶんずらして予約し続ける。
//
// トラックが多いと 16ch では足りないので、16ch の組(ポート)を足して使う(シンセは始めは 16ch。必要になったら足す)。
// 再生のメッセージは { data, port } で、チャンネルの番号は port × 16 + data のチャンネル。
//
// オーディオトラックの音声も、同じ AudioContext で、シンセの音と同じ時刻の基準で予約して鳴らす(AudioBufferSourceNode)。
// トラックごとに音量(GainNode)とパン(StereoPannerNode)を通す。音声は読み込んで(デコードして)覚えておき、使い回す。

import { DRUM_CHANNEL, secondsToTicks, ticksToSeconds } from './domain/midi.js';
import { loadAudioFile } from './store/audioFileStore.js';
import { loadSoundFont, removeSoundFont, saveSoundFont } from './store/soundFontStore.js';

const LIB_URL = 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/+esm';
const PROCESSOR_URL = 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/dist/spessasynth_processor.min.js';
const LOOKAHEAD = 0.15; // 秒
const INTERVAL_MS = 25;
const START_DELAY = 0.08; // 音色の切り替えを先に届けるための間(秒)
const PREVIEW = 0.25; // 試し弾きの長さ(秒)
const AUDIO_DELAY = 0.03; // 再生中に音声を鳴らし直すときの間(秒)。読み込み済みでも、すぐの時刻には間に合わないことがある
const RAMP = 0.01; // 再生中に音量・パンを変えるときに、なめらかに移る時間(秒)。いきなり変えるとプツッと鳴る

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
let channelCount = 0; // synth が持つチャンネルの数
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
      channelCount = 16;
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

// ---- 音声(オーディオトラック) ----

// fileId → デコードした AudioBuffer の Promise。このブラウザに中身がなければ null で、覚えない(選び直したら読めるように)
const audioBuffers = new Map();

/** 音声を読み込んでおく(再生を押したときに待たせないため)。読めないものは飛ばす。 */
export function preloadAudio(fileIds) {
   for (const id of fileIds) loadAudioBuffer(id).catch(() => {});
}

function loadAudioBuffer(fileId) {
   if (!audioBuffers.has(fileId)) {
      const promise = (async () => {
         const stored = await loadAudioFile(fileId);
         if (!stored) return null;
         ctx ??= new AudioContext({ latencyHint: 'interactive' });
         return ctx.decodeAudioData(await stored.blob.arrayBuffer());
      })();
      audioBuffers.set(fileId, promise);
      promise.then((buffer) => {
         if (!buffer) audioBuffers.delete(fileId);
      }, () => audioBuffers.delete(fileId));
   }
   return audioBuffers.get(fileId);
}

// 1本の音声を、再生の中で ctx の時刻 at から鳴らす(その時刻に曲のどこにいるかから、ファイルの中の位置を求める)。
// 音声の頭がまだ先なら、頭の時刻まで待って鳴らす。もう終わっているなら鳴らさない
function startAudio(state, item, buffer, at) {
   const songTime = ticksToSeconds(state.fromTick, state.bpm) + (at - state.startAt);
   const offset = songTime - item.startSeconds;
   if (offset >= buffer.duration) return null;
   const source = ctx.createBufferSource();
   source.buffer = buffer;
   const gain = ctx.createGain();
   gain.gain.value = item.gain;
   const panner = ctx.createStereoPanner();
   panner.pan.value = item.pan;
   source.connect(gain).connect(panner).connect(ctx.destination);
   source.start(offset < 0 ? at - offset : at, Math.max(0, offset));
   return { item, source, gain, panner };
}

function stopAudio(voice, at) {
   try {
      voice.source.stop(at);
   } catch {
      // まだ start していない・止め済み
   }
   voice.source.onended = () => voice.panner.disconnect();
}

// 再生中に、鳴らす音声を差し替える。同じファイルが同じ位置にあれば鳴らし続け、音量・パンだけを変える。
// 位置やファイルが変わったもの、新しく聞こえるようになったもの(ミュートを外した)は、いまの位置から鳴らし直す
function updateAudio(state, items) {
   const now = ctx.currentTime;
   const next = new Map(items.map((item) => [item.trackId, item]));
   for (const [trackId, voice] of state.voices) {
      const item = next.get(trackId);
      if (item && item.fileId === voice.item.fileId && item.startSeconds === voice.item.startSeconds) {
         voice.gain.gain.setTargetAtTime(item.gain, now, RAMP);
         voice.panner.pan.setTargetAtTime(item.pan, now, RAMP);
         voice.item = item;
         next.delete(trackId);
         continue;
      }
      stopAudio(voice, now);
      state.voices.delete(trackId);
   }
   for (const item of next.values()) {
      loadAudioBuffer(item.fileId).then((buffer) => {
         if (playing !== state || !buffer || state.voices.has(item.trackId)) return;
         const voice = startAudio(state, item, buffer, ctx.currentTime + AUDIO_DELAY);
         if (voice) state.voices.set(item.trackId, voice);
      }).catch(() => {});
   }
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

// ポート付きのメッセージ({ data, port })を送る。そのポートのチャンネルがまだなければ足す。
// 足したチャンネルは音源が必ずドラムにするので、組の 10ch のほかはドラムをやめる(始めの 16ch と同じにする)
function send(s, { data, port }, options) {
   while (channelCount < (port + 1) * 16) {
      s.addNewChannel();
      s.midiChannels[channelCount].setDrums(channelCount % 16 === DRUM_CHANNEL);
      channelCount++;
   }
   s.sendMessage(data, port * 16, options);
}

// 鳴っている音を覚えておくキー(チャンネル:高さ)
const channelOf = (e) => e.port * 16 + (e.data[0] & 0x0f);
const soundKey = (e) => `${channelOf(e)}:${e.data[1]}`;

let playing = null;

export const isPlaying = () => playing !== null;

/**
 * 再生を始める(再生中なら、止めてから始め直す)。
 * @param {object} options
 * @param {number} options.bpm
 * @param {{ data: number[], port: number }[]} options.setup 頭で送るメッセージ(チャンネルごとの音色・音量・パン)
 * @param {{ tick: number, data: number[], port: number }[]} options.events noteEvents の結果
 * @param {number} options.fromTick ここから鳴らす(曲の頭が 0)
 * @param {number} [options.endTick] ここまでは、鳴らす音がなくても止めない(全トラックをミュートしても再生位置を進める)
 * @param {() => void} [options.onEnd] 最後まで鳴らし終えたとき
 * @param {{ fromTick: number, toTick: number }} [options.loop] この範囲をくり返す(止めるまで終わらない)。
 *    events は範囲の中の1周分(範囲の終わりちょうどのノートオフを含めてよい)。fromTick は範囲の中にする
 * @param {{ trackId: string, fileId: string, startSeconds: number, gain: number, pan: number }[]} [options.audio]
 *    鳴らす音声(domain/audio.js の audioPlayback)。ループでは使わない
 * @returns {Promise<{ missing: string[] }>} このブラウザに中身がなくて鳴らせなかった音声のトラックの id
 */
export async function play({ bpm, setup, events, fromTick, endTick = 0, onEnd, loop = null, audio = [] }) {
   stop();
   const s = await ready();
   // 音声を読み込み終えてから時刻を決める(初めて鳴らすときは、デコードに時間が掛かる)
   const buffers = await Promise.all(audio.map((item) => loadAudioBuffer(item.fileId).catch(() => null)));
   for (const message of setup) send(s, message);
   const startAt = ctx.currentTime + START_DELAY;
   const state = {
      synth: s,
      bpm,
      fromTick,
      startAt,
      // 再生位置より前で始まる音は鳴らさない(途中から鳴らしたときに、頭の切れた音を出さない)。
      // ループでは2周目から全部を鳴らすので、1周目だけ pump で飛ばす
      events: loop ? events : events.filter((e) => afterStart(e, fromTick)),
      index: 0,
      loop,
      cycle: 0, // ループの何周目か(0 始まり)
      sounding: new Map(), // 鳴らした(予約した)まま止めていない音。'チャンネル:高さ' → [チャンネル, 高さ, 鳴らす時刻]
      lastSentAt: startAt,
      sentUntil: -Infinity, // この時刻までのイベントは送った(予約した)
      endTick,
      onEnd,
      timer: null,
      voices: new Map(), // 鳴らしている音声。トラックの id → { item, source, gain, panner }
   };
   playing = state;
   const missing = [];
   audio.forEach((item, i) => {
      if (!buffers[i]) {
         missing.push(item.trackId);
         return;
      }
      const voice = startAudio(state, item, buffers[i], startAt);
      if (voice) state.voices.set(item.trackId, voice);
   });
   state.timer = setInterval(() => pump(state), INTERVAL_MS);
   pump(state);
   emit();
   return { missing };
}

const timeOf = (state, tick) => state.startAt + ticksToSeconds(tick - state.fromTick, state.bpm);
const afterStart = (e, fromTick) => ((e.data[0] & 0xf0) === 0x90 ? e.tick >= fromTick : e.tick > fromTick);
const loopLength = (loop) => loop.toTick - loop.fromTick;
// イベントを鳴らす位置(ループでは周回のぶんずらす)
const tickOf = (state, event) => event.tick + (state.loop ? state.cycle * loopLength(state.loop) : 0);

function pump(state) {
   if (playing !== state) return;
   const now = ctx.currentTime;
   const horizon = now + LOOKAHEAD;
   const { sounding } = state;
   for (;;) {
      if (state.index >= state.events.length) {
         // ループは、頭に戻って次の周回へ(1周分が空なら、何も予約しない)
         if (!state.loop || !state.events.length) break;
         state.cycle++;
         state.index = 0;
      }
      const event = state.events[state.index];
      const at = timeOf(state, tickOf(state, event));
      if (at > horizon) break;
      if (state.loop && state.cycle === 0 && !afterStart(event, state.fromTick)) {
         state.index++;
         continue; // ループの1周目の、再生位置より前の音
      }
      const kind = event.data[0] & 0xf0;
      const key = soundKey(event);
      if (kind === 0x80 && !sounding.has(key)) {
         state.index++;
         continue; // 鳴らしていない音(途中から再生したときの、前の音の終わり)
      }
      send(state.synth, event, { time: Math.max(at, now) });
      if (kind === 0x90) sounding.set(key, [channelOf(event), event.data[1], at]);
      else sounding.delete(key);
      state.lastSentAt = Math.max(state.lastSentAt, at);
      state.index++;
   }
   state.sentUntil = horizon;
   const endAt = Math.max(state.lastSentAt, timeOf(state, state.endTick));
   if (!state.loop && state.index >= state.events.length && now > endAt + 0.1) {
      const { onEnd } = state;
      stop();
      onEnd?.();
   }
}

/**
 * 再生を止めずに、中身を差し替える(ミュート・ソロ、音量・パン、ノートの編集)。止まっていれば何もしない。
 * 鳴らし直すと、いま伸びている音が途切れるため、送り済みの位置より先のイベントだけを入れ替える。
 * 新しい中身に終わり(ノートオフ)がなくなった音(消したノートや、ミュートしたトラックの音)は、すぐに止める。
 * @param {object} options
 * @param {{ data: number[], port: number }[]} [options.messages] すぐに送るメッセージ(変わった音色・音量・パン)
 * @param {{ tick: number, data: number[], port: number }[]} [options.events] 新しいイベント列(noteEvents の結果)。省略すると変えない
 * @param {number} [options.endTick]
 * @param {object[]} [options.audio] 新しい音声(play の audio と同じ形)。省略すると変えない
 */
export function updatePlayback({ messages = [], events, endTick, audio }) {
   const state = playing;
   if (!state) return;
   const now = ctx.currentTime;
   for (const message of messages) send(state.synth, message, { time: now });
   if (endTick != null) state.endTick = endTick;
   if (audio) updateAudio(state, audio);
   if (!events) return;
   let upcoming;
   if (state.loop) {
      // ループでは1周分を全部持ち、送り済みの位置が何周目のどこかを求めて、その先から鳴らす
      const length = loopLength(state.loop);
      const sentTick = Math.max(state.fromTick, state.fromTick + secondsToTicks(state.sentUntil - state.startAt, state.bpm));
      state.cycle = Math.floor((sentTick - state.loop.fromTick) / length);
      const position = sentTick - state.cycle * length;
      state.events = events;
      state.index = events.findIndex((e) => e.tick > position);
      if (state.index < 0) state.index = events.length;
      // この先に来るものは、今の周回の残りと、次の周回の頭
      upcoming = [...events.slice(state.index), ...events.slice(0, state.index)];
   } else {
      state.events = events.filter((e) => timeOf(state, e.tick) > state.sentUntil);
      state.index = 0;
      upcoming = state.events;
   }
   // その高さで次に来るのがノートオフなら、鳴っている音の終わりがまだある(次がノートオンなら、別の音の終わり)
   const ending = new Set();
   const seen = new Set();
   for (const e of upcoming) {
      const k = soundKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      if ((e.data[0] & 0xf0) === 0x80) ending.add(k);
   }
   for (const [k, [channel, pitch, at]] of state.sounding) {
      if (ending.has(k)) continue;
      // 予約だけしてまだ鳴っていない音もあるので、鳴らす時刻より後で止める
      state.synth.noteOff(channel, pitch, { time: Math.max(now, at) + 0.001 });
      state.sounding.delete(k);
   }
}

/**
 * いまの再生位置(tick)。止まっていれば null。音が実際に出るまでの遅れ(outputLatency)を差し引く。
 * ループ再生では、範囲の中に折り返した位置。
 */
export function playbackTick() {
   if (!playing) return null;
   const elapsed = Math.max(0, ctx.currentTime - (ctx.outputLatency || 0) - playing.startAt);
   const tick = playing.fromTick + secondsToTicks(elapsed, playing.bpm);
   const { loop } = playing;
   if (!loop) return tick;
   return loop.fromTick + ((tick - loop.fromTick) % loopLength(loop));
}

/** ループ再生中なら、その範囲。それ以外は null。 */
export const playingLoop = () => playing?.loop ?? null;

export function stop() {
   const state = playing;
   if (!state) return;
   playing = null;
   clearInterval(state.timer);
   // 予約済みでまだ鳴っていない音もあるので、最後に予約した時刻の直後にも止める
   const at = Math.max(ctx.currentTime, state.lastSentAt) + 0.001;
   for (const voice of state.voices.values()) stopAudio(voice, ctx.currentTime);
   for (const [channel, pitch] of state.sounding.values()) state.synth.noteOff(channel, pitch, { time: at });
   for (let channel = 0; channel < channelCount; channel++) {
      const offset = channel - (channel % 16);
      state.synth.sendMessage([0xb0 | (channel % 16), 120, 0], offset, { time: at }); // オールサウンドオフ
      state.synth.sendMessage([0xb0 | (channel % 16), 123, 0], offset, { time: at }); // オールノートオフ
   }
   state.synth.stopAll(true);
   emit();
}
