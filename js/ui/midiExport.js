// .mid の書き出し(ダウンロード)。DAW へは、書き出したファイルを読み込んで渡す。
// オーディオ(WAV)の中身は ../audioExport.js で作り、ダウンロードはここの downloadBlob を使う。

import { buildMidiFile, midiFileName, projectBpm } from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';

/**
 * クリップ1つ分の .mid。クリップの先頭を頭(1小節目)にする。
 * @returns {{ bytes: Uint8Array, fileName: string }}
 */
export function clipMidi(project, track, clip) {
   return {
      bytes: buildMidiFile({ bpm: projectBpm(project), tracks: [track], clips: [clip], offsetBar: clip.startBar }),
      fileName: midiFileName(track.name, clip.name || `${clip.startBar}小節目`),
   };
}

/**
 * アレンジ全体の .mid(トラックごとに1本)。
 * @returns {{ bytes: Uint8Array, fileName: string }}
 */
export function arrangementMidi(project, tracks, clips) {
   return {
      bytes: buildMidiFile({ title: project.title, bpm: projectBpm(project), tracks: sortByOrder(tracks), clips }),
      fileName: midiFileName(project.title),
   };
}

export function downloadMidi({ bytes, fileName }) {
   downloadBlob(new Blob([bytes], { type: 'audio/midi' }), fileName);
}

/** ファイルをダウンロードさせる(.mid、オーディオの書き出しで使う)。 */
export function downloadBlob(blob, fileName) {
   const url = URL.createObjectURL(blob);
   const a = document.createElement('a');
   a.href = url;
   a.download = fileName;
   document.body.append(a);
   a.click();
   a.remove();
   // すぐに取り消すと、ダウンロードが始まる前に URL が無効になることがある
   setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
