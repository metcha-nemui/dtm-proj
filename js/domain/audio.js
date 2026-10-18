// オーディオトラックのドメインロジック。DOMにもrepositoryにも依存しない。
// オーディオトラックは、音声ファイルを1つだけ持ち、曲の中の好きな位置(拍の途中でもよい)から鳴らす。クリップは置かない。
// ファイルの中身は端末ごとの IndexedDB(store/audioFileStore.js)にあり、Track が持つのは、どのファイルか(fileId)と
// 名前・サイズ・長さ(秒)と、鳴らし始める位置(tick)だけ。別の端末では中身がないことがあり、そのときは鳴らさない。
// 音声は伸び縮みさせない(BPM を変えても長さは秒のまま。小節とずれるのは割り切る)。

import {
   audibleTrackIds, CENTER_PAN, DEFAULT_VOLUME, isAudioTrack, playbackInput, PPQ, projectBpm, renderInput, RENDER_TAIL,
   secondsToTicks, ticksToSeconds, TICKS_PER_BAR, trackSound,
} from './midi.js';

/** 波形の表示に使う、1秒あたりの値の数。1小節の幅(28px)に、BPM 60 でも1pxに1つ以上が入る。 */
export const PEAKS_PER_SECOND = 20;

/**
 * トラックの音声の設定。オーディオトラックでなければ、ファイルをまだ選んでいなければ null。
 * @returns {{ fileId: string, name: string, size: number, duration: number, startTick: number } | null}
 */
export function trackAudio(track) {
   const audio = isAudioTrack(track) ? track.audio : null;
   if (!audio?.fileId) return null;
   const duration = Number(audio.duration);
   return {
      fileId: String(audio.fileId),
      name: String(audio.name ?? ''),
      size: Number(audio.size) || 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      startTick: Math.round(Number(audio.startTick) || 0),
   };
}

/** 音声の長さ(tick)。BPM で変わる。 */
export const audioTicks = (audio, bpm) => secondsToTicks(audio.duration, bpm);

/**
 * 鳴らし始める位置として置ける、いちばん前(tick)。頭は1小節目より前に出せる(出した分は鳴らさない。カウントや頭の無音を
 * 切り捨てるため)が、少なくとも1拍は1小節目より後ろに残す(すべてが前に出ると、掴めなくなる)。
 */
export function minAudioStart(audio, bpm) {
   return Math.min(0, Math.ceil(PPQ - audioTicks(audio, bpm)));
}

/** 鳴らし始める位置を、置ける範囲(minAudioStart より後ろ)の整数の tick に収める。 */
export const clampAudioStart = (audio, bpm, startTick) => Math.max(minAudioStart(audio, bpm), Math.round(startTick));

/** 拍の単位に丸める(ドラッグでのスナップ)。 */
export const snapToBeat = (tick) => Math.round(tick / PPQ) * PPQ;

/** 音声が終わる小節(その小節まで掛かる。1始まり)。アレンジの小節数を決めるのに使う。 */
export function audioEndBar(audio, bpm) {
   return Math.max(1, Math.ceil((audio.startTick + audioTicks(audio, bpm)) / TICKS_PER_BAR));
}

/**
 * 音量のつまみ(0〜127)を、音声に掛ける倍率にする。既定の 100 で元の大きさ(1倍)。
 * 曲線は MIDI の音量(CC7)と同じ2乗にする(つまみの効き方を MIDI のトラックと揃える)。
 */
export const audioGain = (volume) => (volume / DEFAULT_VOLUME) ** 2;

/** パンのつまみ(0〜127。64 が中央)を、-1(左)〜 1(右)にする(Web Audio の StereoPannerNode の値)。 */
export const audioPan = (pan) => Math.max(-1, Math.min(1, (pan - CENTER_PAN) / (CENTER_PAN - 1)));

/**
 * パンを掛けたときの、左右の入力から左右の出力への倍率。再生に使う StereoPannerNode と同じ計算
 * (Web Audio の仕様の式)を、書き出しでも使う(書き出した音を再生と同じにするため)。
 * 出力は L = inL × ll + inR × rl、R = inL × lr + inR × rr。モノラルは inL だけを使う(inR は 0)。
 * @param {number} pan -1〜1(audioPan の値)
 * @param {number} channels 入力のチャンネル数(1 か 2)
 */
export function panMatrix(pan, channels) {
   if (channels === 1) {
      const x = ((pan + 1) / 2) * (Math.PI / 2);
      return { ll: Math.cos(x), rl: 0, lr: Math.sin(x), rr: 0 };
   }
   if (pan <= 0) {
      const x = (pan + 1) * (Math.PI / 2);
      return { ll: 1, rl: Math.cos(x), lr: 0, rr: Math.sin(x) };
   }
   const x = pan * (Math.PI / 2);
   return { ll: Math.cos(x), rl: 0, lr: Math.sin(x), rr: 1 };
}

/**
 * 再生で鳴らす音声。ミュート・ソロで聞こえるトラックの、ファイルを選んであるものだけ。
 * 位置は秒(曲の頭が 0。頭を1小節目より前に出していれば負)。
 * @param {{ project: object, tracks: object[] }} data
 * @returns {{ trackId: string, fileId: string, startSeconds: number, gain: number, pan: number }[]}
 */
export function audioPlayback({ project, tracks }) {
   const bpm = projectBpm(project);
   const audible = audibleTrackIds(tracks);
   return tracks.filter((t) => audible.has(t.id) && trackAudio(t)).map((t) => {
      const { volume, pan } = trackSound(t);
      const audio = trackAudio(t);
      return { trackId: t.id, fileId: audio.fileId, startSeconds: ticksToSeconds(audio.startTick, bpm), gain: audioGain(volume), pan: audioPan(pan) };
   });
}

/** 音声がいちばん遅く終わる位置(tick)。ミュートしたトラックのものも数える。なければ 0。 */
export function audioEndTick({ project, tracks }) {
   const bpm = projectBpm(project);
   return Math.max(0, ...tracks.map(trackAudio).filter(Boolean).map((a) => Math.ceil(a.startTick + audioTicks(a, bpm))));
}

/**
 * 再生する中身。playbackInput(MIDI)に、鳴らす音声(audio)を足し、再生の終わりを音声の終わりまで延ばす。
 * ループ(クリップ1つをくり返す)では、音声は鳴らさない。
 * @returns {ReturnType<typeof playbackInput> & { audio: ReturnType<typeof audioPlayback> } | null}
 */
export function arrangementPlayback(data, loopClipId = null) {
   const input = playbackInput(data, loopClipId);
   if (!input) return null;
   if (input.loop) return { ...input, audio: [] };
   return { ...input, audio: audioPlayback(data), endTick: Math.max(input.endTick, audioEndTick(data)) };
}

/**
 * オーディオの書き出しで作る中身。renderInput(MIDI)に、混ぜる音声(audio。位置はサンプルの番号)を足し、
 * 長さを音声の終わり(に RENDER_TAIL を足したところ)まで延ばす。
 * @returns {ReturnType<typeof renderInput> & { audio: { trackId: string, fileId: string, frame: number, gain: number, pan: number }[] }}
 */
export function arrangementRender(data, sampleRate) {
   const input = renderInput(data, sampleRate);
   const bpm = projectBpm(data.project);
   const end = Math.round(ticksToSeconds(audioEndTick(data), bpm) * sampleRate) + Math.round(RENDER_TAIL * sampleRate);
   return {
      ...input,
      audio: audioPlayback(data).map(({ startSeconds, ...rest }) => ({ ...rest, frame: Math.round(startSeconds * sampleRate) })),
      frames: Math.max(input.frames, end),
   };
}

/**
 * 波形の表示に使う値。PEAKS_PER_SECOND ごとに区切り、その中のいちばん大きな振れ幅(全チャンネル)を 0〜255 で持つ。
 * いちばん大きいものを 255 にする(小さく録った音でも形が見えるように)。
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function audioPeaks(channels, sampleRate) {
   const length = channels[0]?.length ?? 0;
   const step = sampleRate / PEAKS_PER_SECOND;
   const count = Math.ceil(length / step);
   const raw = new Float32Array(count);
   for (const data of channels) {
      for (let i = 0; i < count; i++) {
         const end = Math.min(length, Math.round((i + 1) * step));
         let max = raw[i];
         for (let j = Math.round(i * step); j < end; j++) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
         }
         raw[i] = max;
      }
   }
   const top = raw.reduce((a, b) => Math.max(a, b), 0); // 長い音声では、引数に広げると多すぎる
   return Uint8Array.from(raw, (v) => (top > 0 ? Math.round((v / top) * 255) : 0));
}
