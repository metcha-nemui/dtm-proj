// .mid の書き出し(ダウンロード)と、DAW(FL Studio など)へのドラッグ。
// ドラッグは Chrome / Edge の DownloadURL を使う。ドラッグを始めた瞬間に .mid を作り、
// data: URL として渡すと、ブラウザがファイルにしてドロップ先へ渡す(エクスプローラーへ落とせば保存になる)。

import { buildMidiFile, midiFileName, projectBpm } from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';

function toBase64(bytes) {
   let binary = '';
   const CHUNK = 0x8000; // String.fromCharCode に一度に渡せる数には上限がある
   for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
   return btoa(binary);
}

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
   const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
   const a = document.createElement('a');
   a.href = url;
   a.download = fileName;
   document.body.append(a);
   a.click();
   a.remove();
   // すぐに取り消すと、ダウンロードが始まる前に URL が無効になることがある
   setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** dragstart の中で呼ぶ。ドラッグしているものを .mid ファイルとして外へ渡す。 */
export function setMidiDrag(dataTransfer, { bytes, fileName }) {
   dataTransfer.effectAllowed = 'copy';
   dataTransfer.setData('DownloadURL', `audio/midi:${fileName}:data:audio/midi;base64,${toBase64(bytes)}`);
   // ブラウザの中へ落とされたときに、何のドラッグか分かるように
   dataTransfer.setData('text/plain', fileName);
}
