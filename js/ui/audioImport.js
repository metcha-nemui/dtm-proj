// オーディオトラックの音声ファイルを選ぶ(トラックの追加、ファイルの選び直し)。
// 選んだファイルは、読めるか(デコードできるか)を確かめ、長さと波形の値を求めてから、このブラウザの IndexedDB に入れる。
// Track に入れるのは、どのファイルかと名前・サイズ・長さだけ(domain/audio.js)。

import * as actions from '../actions.js';
import { audioPeaks } from '../domain/audio.js';
import { audioFileIds, loadAudioFile, saveAudioFile } from '../store/audioFileStore.js';
import { h } from './components/dom.js';

// 長さと波形を求めるだけなので、低いサンプルレートでデコードする(速く、メモリも少なくて済む)
const ANALYZE_RATE = 8000;
const ACCEPT = 'audio/*,.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.opus,.webm';

/** ファイルを選ばせる。選ばなければ null。 */
function pickFile() {
   return new Promise((resolve) => {
      const picker = h('input', { type: 'file', accept: ACCEPT, onchange: () => resolve(picker.files[0] ?? null), oncancel: () => resolve(null) });
      picker.click();
   });
}

// 読めるかを確かめ、長さ(秒)と波形の値を求める
async function analyze(file) {
   let buffer;
   try {
      buffer = await new OfflineAudioContext(1, 1, ANALYZE_RATE).decodeAudioData(await file.arrayBuffer());
   } catch {
      throw new Error(`「${file.name}」を音声として読み込めませんでした(WAV・MP3・OGG・FLAC・M4A などを選んでください)`);
   }
   const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
   return { duration: buffer.duration, peaks: audioPeaks(channels, buffer.sampleRate) };
}

// 選んだファイルを保存し、Track に入れる中身を返す
async function store(projectId, file, fileId) {
   const { duration, peaks } = await analyze(file);
   await saveAudioFile(fileId, { projectId, file, peaks });
   return { fileId, name: file.name, size: file.size, duration };
}

/** ファイルを選ばせて、オーディオトラックを末尾に足す。名前はファイル名(拡張子を除く)。選ばなければ null。 */
export async function addAudioTrackFromFile(projectId) {
   const file = await pickFile();
   if (!file) return null;
   const audio = await store(projectId, file, crypto.randomUUID());
   return actions.addAudioTrack(projectId, file.name.replace(/\.[^.]+$/, ''), audio);
}

/**
 * ファイルを選ばせて、オーディオトラックの音声を変える。
 * このブラウザに中身がない(別の端末で選んだ)ファイルの選び直しなら、同じ fileId のまま中身を入れる
 * (ほかの端末の中身はそのまま使える)。中身があるものの入れ替えなら、新しい fileId にする(ほかの端末には、ないと出る)。
 * @param {boolean} missing このブラウザに中身がないか
 */
export async function chooseTrackAudio(projectId, track, missing) {
   const file = await pickFile();
   if (!file) return;
   const fileId = missing && track.audio?.fileId ? track.audio.fileId : crypto.randomUUID();
   await actions.setTrackAudio(projectId, track.id, await store(projectId, file, fileId));
}

/** このブラウザに中身がある音声の id。 */
export const presentAudioIds = () => audioFileIds();

// fileId → 波形の値。中身は変わらない(選び直すと fileId が変わる)ので覚えておく
const peaksCache = new Map();

/** 波形の値。中身がなければ null。 */
export async function loadPeaks(fileId) {
   if (!peaksCache.has(fileId)) {
      const stored = await loadAudioFile(fileId);
      if (!stored) return null;
      peaksCache.set(fileId, stored.peaks ?? null);
   }
   return peaksCache.get(fileId);
}
