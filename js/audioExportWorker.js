// オーディオの書き出しで、音を作る Worker(audioExport.js から使う)。
// 再生(synth.js)の AudioWorklet ではなく、spessasynth_core の SpessaSynthProcessor をこの中で直接動かす。
// イベントをサンプル単位の位置で送れ、実時間を待たずに作れる(OfflineAudioContext で AudioWorklet を使う方法は、
// Chromium がワークレットへのメッセージを無視することがあると spessasynth が注意している)。
// spessasynth_core は spessasynth_lib が中で使っているもの。lib の版(4.3.14)を出したときの core の版に固定する。

import { DRUM_CHANNEL } from './domain/midi.js';

const CORE_URL = 'https://cdn.jsdelivr.net/npm/spessasynth_core@4.3.20/+esm';
// 一度に作るサンプル数。SpessaSynthProcessor が一度に作れる上限の既定で、再生の AudioWorklet と同じ単位
const BLOCK = 128;

self.onmessage = async ({ data }) => {
   try {
      const wav = await render(data);
      self.postMessage({ type: 'done', wav }, [wav]);
   } catch (error) {
      self.postMessage({ type: 'error', message: error?.message ?? String(error) });
   }
};

/**
 * @param {{ soundBank: ArrayBuffer, soundBankName: string, sampleRate: number,
 *   setup: { data: number[], port: number }[], events: { frame: number, data: number[], port: number }[], frames: number }} input
 *   setup・events・frames は domain/midi.js の renderInput の結果
 * @returns {Promise<ArrayBuffer>} WAV(ステレオ)
 */
async function render({ soundBank, soundBankName, sampleRate, setup, events, frames }) {
   const { SoundBankLoader, SpessaSynthProcessor, audioToWav } = await import(CORE_URL);
   const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false, effectsEnabled: true });
   try {
      synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(soundBank), 'main');
   } catch (error) {
      throw new Error(`「${soundBankName}」を音源として読み込めませんでした(${error?.message ?? error})`);
   }
   await synth.processorInitialized;

   // ポート付きのメッセージを送る。そのポートのチャンネルがまだなければ足す。
   // 足したチャンネルは音源が必ずドラムにするので、組の 10ch のほかはドラムをやめる(synth.js の send と同じ)
   const send = ({ data, port }) => {
      while (synth.midiChannels.length < (port + 1) * 16) {
         synth.createMIDIChannel();
         const channel = synth.midiChannels.length - 1;
         synth.midiChannels[channel].setDrums(channel % 16 === DRUM_CHANNEL);
      }
      synth.processMessage(data, port * 16);
   };
   for (const message of setup) send(message);

   const left = new Float32Array(frames);
   const right = new Float32Array(frames);
   const blockLeft = new Float32Array(BLOCK);
   const blockRight = new Float32Array(BLOCK);
   let index = 0;
   let reported = 0;
   for (let at = 0; at < frames;) {
      while (index < events.length && events[index].frame <= at) send(events[index++]);
      // 次のイベントの位置で区切る(ブロックの途中でも、ちょうどその位置から鳴らす)
      const next = index < events.length ? events[index].frame : frames;
      const count = Math.min(BLOCK, next - at, frames - at);
      blockLeft.fill(0);
      blockRight.fill(0);
      synth.process(blockLeft, blockRight, 0, count);
      left.set(blockLeft.subarray(0, count), at);
      right.set(blockRight.subarray(0, count), at);
      at += count;
      // 曲の1秒ぶんごとに進み具合を知らせる
      if (at - reported >= sampleRate) {
         reported = at;
         self.postMessage({ type: 'progress', value: at / frames });
      }
   }
   // 音量は再生と同じにする(大きさを揃える正規化はしない)
   return audioToWav([left, right], sampleRate, { normalizeAudio: false });
}
