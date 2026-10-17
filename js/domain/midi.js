// アレンジのクリップを MIDI として扱うためのドメインロジック(ノート、音色、再生するイベント列、.mid の書き出し)。
// DOMにもrepositoryにも依存しない。受け取ったレコードは変更せず、新しい値を返す。
// 拍子は 4/4 固定、テンポは曲全体で1つ(Project.bpm)。テンポチェンジや CC のオートメーションは持たない(下書き用)。
//
// 時間の単位は tick(4分音符 = PPQ tick)。ノートの位置はクリップの先頭からの相対で持つので、
// クリップを動かせばノートも付いていく。クリップの範囲の外にはみ出したノートは消さずに持ち、鳴らさない。

export const PPQ = 480;
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = PPQ * BEATS_PER_BAR;
export const DEFAULT_BPM = 120;
export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const DEFAULT_VELOCITY = 100;
export const DEFAULT_VOLUME = 100;
export const CENTER_PAN = 64;
export const DRUM_CHANNEL = 9; // GM のドラムは 10ch(0始まりで 9)

const clampInt = (n, min, max, fallback) => {
   const v = Math.round(Number(n));
   return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
};

/** BPM を正規化する。数でなければ既定値、範囲の外は端に寄せる。小数第2位まで持つ。 */
export function normalizeBpm(bpm) {
   const v = Number(bpm);
   if (!Number.isFinite(v) || v <= 0) return DEFAULT_BPM;
   return Math.round(Math.max(MIN_BPM, Math.min(MAX_BPM, v)) * 100) / 100;
}

/** プロジェクトの BPM。項目がない(v7 以前の)データでも既定値を返す。 */
export const projectBpm = (project) => normalizeBpm(project?.bpm ?? DEFAULT_BPM);

// ---- ノート ----

/**
 * ノートの並びを正規化する(整数に丸め、範囲に収め、開始位置 → 音の高さの順に並べる)。
 * start は負でもよい(クリップの左端を縮めたときに、手前にはみ出したノート)。
 * @param {Array<{ pitch: number, start: number, length: number, velocity?: number }>} notes
 */
export function normalizeNotes(notes) {
   return (notes ?? [])
      .map((n) => ({
         pitch: clampInt(n.pitch, 0, 127, 60),
         start: clampInt(n.start, -1e9, 1e9, 0),
         length: clampInt(n.length, 1, 1e9, PPQ),
         velocity: clampInt(n.velocity ?? DEFAULT_VELOCITY, 1, 127, DEFAULT_VELOCITY),
      }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/** クリップの長さ(tick)。 */
export const clipTicks = (clip) => clip.bars * TICKS_PER_BAR;

/**
 * 鳴らすノート。クリップの範囲(0 〜 クリップの長さ)で始まるものだけを、範囲の終わりで切って返す。
 * 範囲の外のノートは、データには残っていても鳴らさない(書き出しにも入れない)。
 */
export function audibleNotes(clip) {
   const end = clipTicks(clip);
   return normalizeNotes(clip.notes)
      .filter((n) => n.start >= 0 && n.start < end)
      .map((n) => ({ ...n, length: Math.min(n.length, end - n.start) }));
}

/** 音の高さの名前(60 = C4)。 */
export function pitchName(pitch) {
   const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
   return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

export const isBlackKey = (pitch) => [1, 3, 6, 8, 10].includes(pitch % 12);

// ---- トラックの音 ----

/** トラックの音の設定。項目がない(v7 以前の)データでも既定値を返す。 */
export function trackSound(track) {
   return {
      program: clampInt(track?.program ?? 0, 0, 127, 0),
      volume: clampInt(track?.volume ?? DEFAULT_VOLUME, 0, 127, DEFAULT_VOLUME),
      pan: clampInt(track?.pan ?? CENTER_PAN, 0, 127, CENTER_PAN),
      drum: Boolean(track?.drum),
   };
}

/**
 * トラックごとの MIDI チャンネル(0始まり)。ドラムのトラックは 10ch。
 * それ以外は、トラックの並び順に 1ch から割り振り、10ch は飛ばす。16本目以降は先頭から使い回す
 * (同じチャンネルのトラックは、後に来た方の音色になる)。
 * @param {object[]} tracks 並び順に並べたトラック
 * @returns {Map<string, number>}
 */
export function trackChannels(tracks) {
   const melodic = Array.from({ length: 16 }, (_, i) => i).filter((ch) => ch !== DRUM_CHANNEL);
   const result = new Map();
   let i = 0;
   for (const track of tracks) {
      if (trackSound(track).drum) result.set(track.id, DRUM_CHANNEL);
      else result.set(track.id, melodic[i++ % melodic.length]);
   }
   return result;
}

/** 再生を始めるときに、チャンネルごとに送る設定(音色・音量・パン)。 */
export function setupMessages(track, channel) {
   const { program, volume, pan, drum } = trackSound(track);
   return [
      ...(drum ? [] : [[0xc0 | channel, program]]),
      [0xb0 | channel, 7, volume],
      [0xb0 | channel, 10, pan],
   ];
}

// ---- 再生するイベント列 ----

/**
 * トラックとクリップから、曲の頭からの絶対位置(tick)で並べたノートのイベント列を作る。
 * 同じ位置では、ノートオフを先に置く(同じ高さのノートが続くときに、次の音を消さないため)。
 * @param {{ tracks: object[], clips: object[] }} input tracks は並び順に並べたもの
 * @returns {{ tick: number, data: number[] }[]}
 */
export function noteEvents({ tracks, clips }) {
   const channels = trackChannels(tracks);
   const events = [];
   for (const clip of clips) {
      const channel = channels.get(clip.trackId);
      if (channel == null) continue;
      const offset = (clip.startBar - 1) * TICKS_PER_BAR;
      for (const n of audibleNotes(clip)) {
         events.push({ tick: offset + n.start, data: [0x90 | channel, n.pitch, n.velocity] });
         events.push({ tick: offset + n.start + n.length, data: [0x80 | channel, n.pitch, 0] });
      }
   }
   const isOff = (e) => (e.data[0] & 0xf0) === 0x80;
   return events.sort((a, b) => a.tick - b.tick || Number(isOff(b)) - Number(isOff(a)));
}

/** tick を秒にする。 */
export const ticksToSeconds = (ticks, bpm) => (ticks * 60) / (normalizeBpm(bpm) * PPQ);

/** 秒を tick にする。 */
export const secondsToTicks = (seconds, bpm) => (seconds * normalizeBpm(bpm) * PPQ) / 60;

// ---- Standard MIDI File(.mid)の書き出し ----

// 可変長数値(7ビットずつ、続きがあれば最上位ビットを立てる)
export function varLen(value) {
   const bytes = [value & 0x7f];
   let v = Math.floor(value / 128);
   while (v > 0) {
      bytes.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
   }
   return bytes;
}

const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const utf8 = (s) => [...new TextEncoder().encode(s)];
const metaText = (type, text) => {
   const bytes = utf8(text);
   return [0xff, type, ...varLen(bytes.length), ...bytes];
};

// tick 付きのイベント(data はステータスから始まるバイト列)を、デルタタイム付きのトラックチャンクにする
function trackChunk(events) {
   const body = [];
   let last = 0;
   for (const { tick, data } of events) {
      body.push(...varLen(tick - last), ...data);
      last = tick;
   }
   body.push(0x00, 0xff, 0x2f, 0x00); // トラックの終わり
   return [...ascii('MTrk'), ...u32(body.length), ...body];
}

/**
 * .mid(SMF フォーマット1)のバイト列を作る。1本目はテンポと拍子だけのトラック、2本目以降が各トラック。
 * offsetBar を渡すと、その小節を頭(tick 0)にする(クリップ1つを書き出すとき。クリップの先頭から始まる)。
 * @param {{ title?: string, bpm: number, tracks: object[], clips: object[], offsetBar?: number }} input
 *   tracks は並び順に並べたもの。clips のないトラックも出す
 * @returns {Uint8Array}
 */
export function buildMidiFile({ title = '', bpm, tracks, clips, offsetBar = 1 }) {
   const tempo = Math.round(60_000_000 / normalizeBpm(bpm)); // 4分音符あたりのマイクロ秒
   const conductor = [
      ...(title ? [{ tick: 0, data: metaText(0x03, title) }] : []),
      { tick: 0, data: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
      { tick: 0, data: [0xff, 0x58, 0x04, BEATS_PER_BAR, 2, 24, 8] }, // 4/4
   ];
   const channels = trackChannels(tracks);
   const offset = (offsetBar - 1) * TICKS_PER_BAR;
   const chunks = tracks.map((track) => {
      const channel = channels.get(track.id);
      const notes = noteEvents({ tracks, clips: clips.filter((c) => c.trackId === track.id) })
         .map((e) => ({ tick: e.tick - offset, data: e.data }))
         .filter((e) => e.tick >= 0);
      return trackChunk([
         { tick: 0, data: metaText(0x03, track.name) },
         ...setupMessages(track, channel).map((data) => ({ tick: 0, data })),
         ...notes,
      ]);
   });
   const header = [...ascii('MThd'), ...u32(6), 0, 1, 0, chunks.length + 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
   return new Uint8Array([...header, ...trackChunk(conductor), ...chunks.flat()]);
}

/** 書き出すファイルの名前。Windows で使えない文字と、ドラッグの指定(DownloadURL)を壊すコロンを除く。 */
export function midiFileName(...parts) {
   const name = parts.filter(Boolean).join(' - ').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
   return `${name || 'clip'}.mid`;
}

// ---- 音色の名前(General MIDI) ----

export const GM_PROGRAMS = [
   'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
   'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
   'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
   'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
   'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
   'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
   'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
   'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
   'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
   'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
   'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit',
   'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
   'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
   'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
   'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
   'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
   'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
   'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
   'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
   'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
   'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
   'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
   'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/** トラックの音色の表示名。 */
export function soundLabel(track) {
   const { program, drum } = trackSound(track);
   return drum ? 'ドラム' : `${program + 1}. ${GM_PROGRAMS[program]}`;
}
