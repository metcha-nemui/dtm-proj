// オーディオ(WAV)の書き出し。設定画面で選んだ音源で、アレンジ全体を実時間を待たずに鳴らしてファイルにする。
// 音を作るのは audioExportWorker.js(画面を止めないよう Worker で動かす)。何を鳴らすかは domain/midi.js の renderInput。
// 再生用のシンセ(synth.js)とは別に、音源ファイルをもう1つ Worker の中で読み込む。
// オーディオトラックの音声は、Worker の中ではデコードできない(AudioContext がない)ので、ここで書き出しのサンプルレートに
// 合わせてデコードし、波形を Worker に渡して混ぜてもらう。

import { arrangementRender, panMatrix } from './domain/audio.js';
import { loadAudioFile } from './store/audioFileStore.js';
import { loadSoundFont } from './store/soundFontStore.js';
import { NoSoundFontError } from './synth.js';

const SAMPLE_RATE = 44100;

// 音声を書き出しのサンプルレートでデコードし、左右の波形にする(モノラルなら right は null)。中身がなければ null
async function decodeAudio(fileId) {
   const stored = await loadAudioFile(fileId);
   if (!stored) return null;
   const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await stored.blob.arrayBuffer());
   // AudioBuffer の中身は Worker へ譲れない(移すと AudioBuffer が壊れる)ので、写しを作って譲る
   const copy = (channel) => new Float32Array(buffer.getChannelData(channel));
   return { left: copy(0), right: buffer.numberOfChannels > 1 ? copy(1) : null };
}

/**
 * @param {{ project: object, tracks: object[], clips: object[] }} data tracks は並び順に並べたもの
 * @param {(progress: number) => void} [onProgress] 進み具合(0〜1)
 * @returns {Promise<{ blob: Blob, missing: string[] }>} WAV と、このブラウザに中身がなくて混ぜなかった音声のトラックの id。
 *    音源が選ばれていなければ NoSoundFontError で失敗する
 */
export async function renderWav(data, onProgress) {
   const input = arrangementRender(data, SAMPLE_RATE);
   if (!input.events.length && !input.audio.length) {
      throw new Error('書き出す音がありません(ノートや音声がないか、鳴らすトラックがすべてミュートされています)');
   }
   const stored = await loadSoundFont();
   if (!stored) throw new NoSoundFontError();
   const soundBank = await stored.blob.arrayBuffer();
   const missing = [];
   const audio = [];
   for (const item of input.audio) {
      const decoded = await decodeAudio(item.fileId);
      if (!decoded) {
         missing.push(item.trackId);
         continue;
      }
      audio.push({ ...decoded, frame: item.frame, gain: item.gain, matrix: panMatrix(item.pan, decoded.right ? 2 : 1) });
   }
   const transfer = [soundBank, ...audio.flatMap((a) => [a.left.buffer, a.right?.buffer].filter(Boolean))];
   const worker = new Worker(new URL('./audioExportWorker.js', import.meta.url), { type: 'module' });
   try {
      return await new Promise((resolve, reject) => {
         worker.onmessage = ({ data: message }) => {
            if (message.type === 'progress') onProgress?.(message.value);
            else if (message.type === 'done') resolve({ blob: new Blob([message.wav], { type: 'audio/wav' }), missing });
            else reject(new Error(message.message));
         };
         // Worker の読み込みに失敗したとき(CDN につながらないなど)
         worker.onerror = (event) => reject(new Error(`書き出しに失敗しました(${event.message || '読み込めません'})`));
         worker.postMessage({ soundBank, soundBankName: stored.name, sampleRate: SAMPLE_RATE, ...input, audio }, transfer);
      });
   } finally {
      worker.terminate();
   }
}
