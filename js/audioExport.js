// オーディオ(WAV)の書き出し。設定画面で選んだ音源で、アレンジ全体を実時間を待たずに鳴らしてファイルにする。
// 音を作るのは audioExportWorker.js(画面を止めないよう Worker で動かす)。何を鳴らすかは domain/midi.js の renderInput。
// 再生用のシンセ(synth.js)とは別に、音源ファイルをもう1つ Worker の中で読み込む。

import { renderInput } from './domain/midi.js';
import { loadSoundFont } from './store/soundFontStore.js';
import { NoSoundFontError } from './synth.js';

const SAMPLE_RATE = 44100;

/**
 * @param {{ project: object, tracks: object[], clips: object[] }} data tracks は並び順に並べたもの
 * @param {(progress: number) => void} [onProgress] 進み具合(0〜1)
 * @returns {Promise<Blob>} WAV。音源が選ばれていなければ NoSoundFontError で失敗する
 */
export async function renderWav(data, onProgress) {
   const input = renderInput(data, SAMPLE_RATE);
   if (!input.events.length) throw new Error('書き出す音がありません(ノートがないか、鳴らすトラックがすべてミュートされています)');
   const stored = await loadSoundFont();
   if (!stored) throw new NoSoundFontError();
   const soundBank = await stored.blob.arrayBuffer();
   const worker = new Worker(new URL('./audioExportWorker.js', import.meta.url), { type: 'module' });
   try {
      return await new Promise((resolve, reject) => {
         worker.onmessage = ({ data: message }) => {
            if (message.type === 'progress') onProgress?.(message.value);
            else if (message.type === 'done') resolve(new Blob([message.wav], { type: 'audio/wav' }));
            else reject(new Error(message.message));
         };
         // Worker の読み込みに失敗したとき(CDN につながらないなど)
         worker.onerror = (event) => reject(new Error(`書き出しに失敗しました(${event.message || '読み込めません'})`));
         worker.postMessage({ soundBank, soundBankName: stored.name, sampleRate: SAMPLE_RATE, ...input }, [soundBank]);
      });
   } finally {
      worker.terminate();
   }
}
