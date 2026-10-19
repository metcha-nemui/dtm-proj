// アレンジのクリップを MIDI として扱うためのドメインロジック(ノート、音色、再生するイベント列、.mid の書き出しと読み込み)。
// DOMにもrepositoryにも依存しない。受け取ったレコードは変更せず、新しい値を返す。
// 拍子は 4/4 固定、テンポは曲全体で1つ(Project.bpm)。キーは小節単位で変えられる(Project.scales。ピアノロールの表示だけに使う)。テンポチェンジや CC のオートメーションは持たない(下書き用)。
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
// リバーブを ON にしたトラックのセンド量(CC91)。spessasynth は CC91 の初期値が 0(掛からない)なので、
// GS のリセット時の値(40)を送る。リバーブ本体の設定(種類・残響時間・リターンの量)は spessasynth の既定のまま
export const REVERB_SEND = 40;

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
   return `${KEY_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

export const isBlackKey = (pitch) => [1, 3, 6, 8, 10].includes(pitch % 12);

// ---- スケール(ピアノロールの行の塗り分けに使う) ----

// キー(主音)とメジャー / マイナーだけを持つ。教会旋法などは扱わない。マイナーは自然的短音階
export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALE_MODES = [
   { value: 'major', label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
   { value: 'minor', label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
];
export const DEFAULT_SCALE = Object.freeze({ root: 0, mode: 'major' });

/** スケールを正規化する。主音は 0〜11(0 = C)、mode は 'major' か 'minor'。おかしな値は C メジャーに寄せる。 */
export function normalizeScale(scale) {
   const root = Math.round(Number(scale?.root));
   return {
      root: Number.isFinite(root) ? ((root % 12) + 12) % 12 : DEFAULT_SCALE.root,
      mode: SCALE_MODES.some((m) => m.value === scale?.mode) ? scale.mode : DEFAULT_SCALE.mode,
   };
}

/**
 * スケールの並び(転調)を正規化する。小節(1以上の整数)の順に並べ、同じ小節は後のものを残す。
 * 1小節目は必ずある(なければ C メジャーを足す)。曲の頭のスケールを決めるため。
 * @param {Array<{ bar: number, root: number, mode: string }>} scales
 * @returns {Array<{ bar: number, root: number, mode: 'major'|'minor' }>}
 */
export function normalizeScales(scales) {
   const byBar = new Map();
   for (const s of scales ?? []) {
      const bar = clampInt(s?.bar, 1, 1e6, 1);
      byBar.set(bar, { bar, ...normalizeScale(s) });
   }
   if (!byBar.has(1)) byBar.set(1, { bar: 1, ...DEFAULT_SCALE });
   return [...byBar.values()].sort((a, b) => a.bar - b.bar);
}

/** プロジェクトのスケールの並び。項目がない(v9 より前の)データでも、1小節目から C メジャーを返す。 */
export const projectScales = (project) => normalizeScales(project?.scales);

/** その小節のスケール(その小節かそれより前で、いちばん後の転調)。 */
export function scaleAt(scales, bar) {
   const list = normalizeScales(scales);
   let current = list[0];
   for (const s of list) if (s.bar <= bar) current = s;
   return normalizeScale(current);
}

/**
 * 小節の範囲に掛かるスケールの区間。ピアノロールで、クリップの中の転調ごとに塗り分けるのに使う。
 * @param {object[]} scales
 * @param {number} startBar
 * @param {number} bars
 * @returns {Array<{ from: number, to: number, scale: { root: number, mode: string } }>} from / to は startBar からの小節数(to は含まない)
 */
export function scaleSpans(scales, startBar, bars) {
   const list = normalizeScales(scales);
   const cuts = [0, ...list.map((s) => s.bar - startBar).filter((d) => d > 0 && d < bars), bars];
   return cuts.slice(0, -1).map((from, i) => ({ from, to: cuts[i + 1], scale: scaleAt(list, startBar + from) }));
}

/** その小節にスケールを置く(あれば変える)。 */
export function setScaleAt(scales, bar, scale) {
   return normalizeScales([...normalizeScales(scales), { ...normalizeScale(scale), bar }]);
}

/** 転調の小節を動かす。1小節目のものは動かせず、ほかの転調と同じ小節にも動かせない。 */
export function moveScale(scales, fromBar, toBar) {
   const list = normalizeScales(scales);
   const target = list.find((s) => s.bar === fromBar);
   if (!target) throw new Error('スケールが見つかりません');
   if (fromBar === 1) throw new Error('1小節目のスケールは動かせません');
   if (toBar < 1 || list.some((s) => s.bar === toBar)) throw new Error('その小節にはスケールがあります');
   return normalizeScales(list.map((s) => (s === target ? { ...s, bar: toBar } : s)));
}

/** 転調を消す(その小節から、前のスケールが続く)。1小節目のものは消せない。 */
export function removeScale(scales, bar) {
   if (bar === 1) throw new Error('1小節目のスケールは消せません');
   const list = normalizeScales(scales);
   if (!list.some((s) => s.bar === bar)) throw new Error('スケールが見つかりません');
   return list.filter((s) => s.bar !== bar);
}

/** その音がスケールの音か。 */
export function inScale(pitch, scale) {
   const { root, mode } = normalizeScale(scale);
   const steps = SCALE_MODES.find((m) => m.value === mode).steps;
   return steps.includes((((pitch - root) % 12) + 12) % 12);
}

/** スケールの表記(例: 「A Minor」)。 */
export function scaleLabel(scale) {
   const { root, mode } = normalizeScale(scale);
   return `${KEY_NAMES[root]} ${SCALE_MODES.find((m) => m.value === mode).label}`;
}

// ---- トラックの音 ----

/** オーディオトラック(音声ファイルを1つ鳴らす。クリップもノートも持たない)か。項目がなければ MIDI のトラック。 */
export const isAudioTrack = (track) => track?.kind === 'audio';

/** トラックの音の設定。項目がない(v7 以前の)データでも既定値を返す。 */
export function trackSound(track) {
   return {
      program: clampInt(track?.program ?? 0, 0, 127, 0),
      volume: clampInt(track?.volume ?? DEFAULT_VOLUME, 0, 127, DEFAULT_VOLUME),
      pan: clampInt(track?.pan ?? CENTER_PAN, 0, 127, CENTER_PAN),
      drum: Boolean(track?.drum),
      kit: clampInt(track?.kit ?? 0, 0, 127, 0),
   };
}

/**
 * トラックの、再生だけに効く設定(ミュート・ソロ・リバーブ)。項目がない(足す前の)データでも、
 * ミュート・ソロは false、リバーブは true を返す。
 */
export function trackMix(track) {
   return { mute: Boolean(track?.mute), solo: Boolean(track?.solo), reverb: track?.reverb !== false };
}

/**
 * 再生で鳴らすトラックの id。ソロのトラックがあればソロのものだけ、なければミュートしていないものを鳴らす
 * (ソロはミュートより強い。ソロにしたトラックは、ミュートしていても鳴らす)。
 * 書き出し(.mid)には使わない(DAW へは全トラックを渡す)。
 * @param {object[]} tracks
 * @param {string|null} [alwaysId] ミュート・ソロに関わらず鳴らすトラック(ピアノロールで、編集中のクリップを頭から再生するとき)
 * @returns {Set<string>}
 */
export function audibleTrackIds(tracks, alwaysId = null) {
   const soloing = tracks.some((t) => trackMix(t).solo);
   const ids = new Set(tracks.filter((t) => (soloing ? trackMix(t).solo : !trackMix(t).mute)).map((t) => t.id));
   if (alwaysId != null) ids.add(alwaysId);
   return ids;
}

const MELODIC_CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter((ch) => ch !== DRUM_CHANNEL);

/**
 * トラックごとの MIDI チャンネル(0始まり)。ドラムのトラックは 10ch。
 * それ以外は、トラックの並び順に 1ch から割り振り、10ch は飛ばす。
 * wrap(.mid の書き出し。16ch しかない)では、16本目以降は先頭から使い回す
 * (同じチャンネルのトラックは、後に来た方の音色になる)。ドラムはすべて 10ch。
 * wrap しない(ブラウザの音源で再生するとき)では、16ch の組(ポート)を足していき、どのトラックも別のチャンネルにする。
 * 番号は 16 以上にもなる(ポート × 16 + その中のチャンネル)。音源はどの組でも 10番目をドラムとして扱うので、
 * n 本目のドラムは n 組目の 10ch にする。
 * オーディオトラックはチャンネルを使わないので、数えずに飛ばす(Map にも入らない)。
 * @param {object[]} tracks 並び順に並べたトラック
 * @returns {Map<string, number>}
 */
export function trackChannels(tracks, { wrap = true } = {}) {
   const result = new Map();
   let melodic = 0;
   let drums = 0;
   for (const track of tracks) {
      if (isAudioTrack(track)) continue;
      if (trackSound(track).drum) {
         result.set(track.id, (wrap ? 0 : drums++ * 16) + DRUM_CHANNEL);
         continue;
      }
      const port = wrap ? 0 : Math.floor(melodic / MELODIC_CHANNELS.length);
      result.set(track.id, port * 16 + MELODIC_CHANNELS[melodic++ % MELODIC_CHANNELS.length]);
   }
   return result;
}

// trackChannels の番号を、ポート(16ch の組)とその中のチャンネル(0〜15。MIDI のメッセージに入れる方)に分ける
const splitChannel = (channel) => ({ port: Math.floor(channel / 16), ch: channel % 16 });

// 再生で送るメッセージ(ポート付き)にする
const withPort = (track, channel) => {
   const { port, ch } = splitChannel(channel);
   return playbackMessages(track, ch).map((data) => ({ data, port }));
};

/**
 * チャンネルごとの設定(音色・音量・パン)。.mid の書き出しではトラックの頭に置く(再生では playbackMessages)。
 * ドラムのトラックでは、音色の代わりにキットの番号をプログラムチェンジで送る(GS の決まり。10ch のプログラムで
 * キットが切り替わる。バンクセレクトは使わない)。
 */
export function setupMessages(track, channel) {
   const { program, volume, pan, drum, kit } = trackSound(track);
   return [
      [0xc0 | channel, drum ? kit : program],
      [0xb0 | channel, 7, volume],
      [0xb0 | channel, 10, pan],
   ];
}

/**
 * ブラウザの音源で鳴らすときに、チャンネルごとに送る設定。setupMessages に、リバーブのセンド量(CC91)を足したもの。
 * リバーブはこのアプリの再生だけに使うので、.mid の書き出し(setupMessages)には入れない。
 * OFF のときも 0 を送る(同じチャンネルで前に鳴らしたトラックの量を残さない)。
 */
export function playbackMessages(track, channel) {
   return [...setupMessages(track, channel), [0xb0 | channel, 91, trackMix(track).reverb ? REVERB_SEND : 0]];
}

// ---- 再生するイベント列 ----

/**
 * トラックとクリップから、曲の頭からの絶対位置(tick)で並べたノートのイベント列を作る。
 * 同じ位置では、ノートオフを先に置く(同じ高さのノートが続くときに、次の音を消さないため)。
 * port は trackChannels のポート(wrap ならいつも 0)。
 * @param {{ tracks: object[], clips: object[], wrap?: boolean }} input tracks は並び順に並べたもの。wrap は trackChannels に渡す
 * @returns {{ tick: number, data: number[], port: number }[]}
 */
export function noteEvents({ tracks, clips, wrap = true }) {
   const channels = trackChannels(tracks, { wrap });
   const events = [];
   for (const clip of clips) {
      if (!channels.has(clip.trackId)) continue;
      const { port, ch } = splitChannel(channels.get(clip.trackId));
      const offset = (clip.startBar - 1) * TICKS_PER_BAR;
      for (const n of audibleNotes(clip)) {
         events.push({ tick: offset + n.start, data: [0x90 | ch, n.pitch, n.velocity], port });
         events.push({ tick: offset + n.start + n.length, data: [0x80 | ch, n.pitch, 0], port });
      }
   }
   const isOff = (e) => (e.data[0] & 0xf0) === 0x80;
   return events.sort((a, b) => a.tick - b.tick || Number(isOff(b)) - Number(isOff(a)));
}

/** クリップの範囲を、曲の頭からの tick で。toTick はクリップの右端(含まない) */
export const clipTickRange = (clip) => ({
   fromTick: (clip.startBar - 1) * TICKS_PER_BAR,
   toTick: (clip.startBar - 1 + clip.bars) * TICKS_PER_BAR,
});

/**
 * 再生する中身(音源に渡すもの)。
 * loopClipId を渡すと、そのクリップのノートだけを、トラックのミュート・ソロに関わらずループで鳴らす(loop にクリップの範囲)。
 * そのクリップかトラックが消えていれば null。
 * 渡さなければ全体で、鳴らすのはミュート・ソロで聞こえるトラックだけ。ただし endTick(再生の終わり)には、
 * ミュートしたトラックの音も数える(全部ミュートしても、曲の終わりまで再生位置を進める)。
 * 音源は 16ch より多く持てるので、チャンネルは使い回さない(trackChannels の wrap なし)。メッセージには port が付く。
 * @param {{ project: object, tracks: object[], clips: object[] }} data tracks は並び順に並べたもの
 * @returns {{ bpm: number, setup: { data: number[], port: number }[], events: { tick: number, data: number[], port: number }[], loop?: { fromTick: number, toTick: number }, endTick?: number } | null}
 */
export function playbackInput({ project, tracks, clips }, loopClipId = null) {
   const channels = trackChannels(tracks, { wrap: false });
   if (loopClipId) {
      const clip = clips.find((c) => c.id === loopClipId);
      const track = clip && tracks.find((t) => t.id === clip.trackId);
      if (!track) return null;
      return {
         bpm: projectBpm(project),
         setup: withPort(track, channels.get(track.id)),
         events: noteEvents({ tracks, clips: [clip], wrap: false }),
         loop: clipTickRange(clip),
      };
   }
   const audible = audibleTrackIds(tracks);
   const all = noteEvents({ tracks, clips, wrap: false });
   return {
      bpm: projectBpm(project),
      setup: tracks.filter((t) => channels.has(t.id)).flatMap((t) => withPort(t, channels.get(t.id))),
      events: noteEvents({ tracks, clips: clips.filter((c) => audible.has(c.trackId)), wrap: false }),
      endTick: all.at(-1)?.tick ?? 0,
   };
}

/** tick を秒にする。 */
export const ticksToSeconds = (ticks, bpm) => (ticks * 60) / (normalizeBpm(bpm) * PPQ);

/** 秒を tick にする。 */
export const secondsToTicks = (seconds, bpm) => (seconds * normalizeBpm(bpm) * PPQ) / 60;

// ---- オーディオの書き出し ----

/** オーディオの書き出しで、最後の音のあとに足す長さ(秒)。リバーブの残響と音の消え際を切らないため。 */
export const RENDER_TAIL = 2;

/**
 * オーディオの書き出しで音源に送る中身。曲の頭から、再生(playbackInput の全体)と同じものを鳴らす(ミュート・ソロも効く)。
 * 位置は tick の代わりにサンプルの番号(frame)にする。
 * frames は書き出す長さ。再生の終わり(ミュートしたトラックの音も数える)に RENDER_TAIL を足す。
 * 一部のトラックだけ(ソロ)で書き出しても長さが揃い、DAW で頭を合わせて並べられる。
 * @returns {{ setup: { data: number[], port: number }[], events: { frame: number, data: number[], port: number }[], frames: number }}
 */
export function renderInput({ project, tracks, clips }, sampleRate) {
   const input = playbackInput({ project, tracks, clips });
   const frameOf = (tick) => Math.round(ticksToSeconds(tick, input.bpm) * sampleRate);
   return {
      setup: input.setup,
      events: input.events.map((e) => ({ frame: frameOf(e.tick), data: e.data, port: e.port })),
      frames: frameOf(input.endTick) + Math.round(RENDER_TAIL * sampleRate),
   };
}

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
 *   tracks は並び順に並べたもの。clips のないトラックも出す。オーディオトラックは出さない
 * @returns {Uint8Array}
 */
export function buildMidiFile({ title = '', bpm, tracks: allTracks, clips, offsetBar = 1 }) {
   const tracks = allTracks.filter((t) => !isAudioTrack(t));
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

// ---- Standard MIDI File(.mid)の読み込み ----

/**
 * .mid(SMF フォーマット0 / 1)を読み、ノートだけを取り出す。クリップに読み込むのに使う(FL Studio のピアノロールで
 * 書き出したものを想定)。位置はファイルの頭(tick 0)からの、このアプリの tick(PPQ)に換算する。
 * テンポは使わない(tick のまま取り込めば位置は保たれる)。CC・ピッチベンド・プログラムチェンジなどは読み込まず、数だけ返す。
 * トラックとチャンネルの組ごとに分けて返す(フォーマット0 の複数チャンネルも、別々に選べるようにするため)。
 * ノートオフはベロシティ 0 のノートオンでもよい。同じ高さのノートが重なったときは、先に始まったものから閉じる。
 * トラックの終わりまで閉じなかったノートは、トラックの終わりで閉じる。
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{ tracks: { name: string, channel: number, notes: object[] }[], otherMeter: boolean, skipped: number }}
 *   tracks はノートのあるものだけ(ファイルの順)。otherMeter は 4/4 以外の拍子があるか。skipped は読み込まなかったイベントの数
 */
export function parseMidiFile(input) {
   const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
   const broken = () => new Error('.mid ファイルとして読めません');
   const text = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
   const u16 = (at) => (bytes[at] << 8) | bytes[at + 1];
   const u32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

   if (bytes.length < 14 || text(0, 4) !== 'MThd') throw broken();
   const headerLength = u32(4);
   const format = u16(8);
   const division = u16(12);
   if (format > 1) throw new Error(`フォーマット${format}の .mid には対応していません`);
   // 最上位ビットが立っていれば SMPTE(秒ベース)の時間単位。拍に換算できないので扱わない
   if (division & 0x8000 || division === 0) throw new Error('この時間単位(SMPTE)の .mid には対応していません');
   const toTick = (tick) => Math.round((tick * PPQ) / division);

   const groups = new Map(); // `${トラック}:${チャンネル}` → { name, channel, notes }
   let otherMeter = false;
   let skipped = 0;
   let trackIndex = 0;
   for (let at = 8 + headerLength; at + 8 <= bytes.length;) {
      const type = text(at, at + 4);
      const end = at + 8 + u32(at + 4);
      if (end > bytes.length) throw broken();
      if (type === 'MTrk') {
         const track = readTrack(at + 8, end);
         for (const [channel, notes] of track.notes) {
            groups.set(`${trackIndex}:${channel}`, { name: track.name, channel, notes, multi: track.notes.size > 1 });
         }
         trackIndex++;
      }
      at = end; // 知らない種類のチャンクは読み飛ばす
   }

   function readTrack(from, end) {
      let pos = from;
      const byte = () => {
         if (pos >= end) throw broken();
         return bytes[pos++];
      };
      const readVarLen = () => {
         let value = 0;
         for (let i = 0; i < 4; i++) {
            const b = byte();
            value = value * 128 + (b & 0x7f);
            if (!(b & 0x80)) return value;
         }
         throw broken();
      };
      let name = '';
      let tick = 0;
      let status = 0; // ランニングステータス(直前のチャンネルメッセージのステータス)
      const open = new Map(); // `${チャンネル}:${高さ}` → 鳴っているノート(始まった順)
      const notes = new Map(); // チャンネル → ノート
      const close = (key, at) => {
         const note = open.get(key)?.shift();
         if (!note) return; // 対になるノートオンがない
         const start = toTick(note.start);
         notes.get(note.channel).push({ pitch: note.pitch, start, length: Math.max(1, toTick(at) - start), velocity: note.velocity });
      };
      while (pos < end) {
         tick += readVarLen();
         let b = bytes[pos];
         if (b & 0x80) pos++;
         else if (status) b = status;
         else throw broken();
         if (b === 0xff) {
            status = 0;
            const meta = byte();
            const length = readVarLen();
            if (pos + length > end) throw broken();
            const body = bytes.subarray(pos, pos + length);
            pos += length;
            if (meta === 0x03 && !name) name = new TextDecoder().decode(body).trim();
            if (meta === 0x58 && (body[0] !== BEATS_PER_BAR || body[1] !== 2)) otherMeter = true;
            if (meta === 0x2f) break;
         } else if (b === 0xf0 || b === 0xf7) {
            status = 0;
            pos += readVarLen(); // SysEx は使わない
            if (pos > end) throw broken();
         } else {
            status = b;
            const kind = b & 0xf0;
            const channel = b & 0x0f;
            const d1 = byte();
            const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : byte();
            const key = `${channel}:${d1}`;
            if (kind === 0x90 && d2 > 0) {
               if (!open.has(key)) open.set(key, []);
               open.get(key).push({ channel, pitch: d1, velocity: d2, start: tick });
               if (!notes.has(channel)) notes.set(channel, []);
            } else if (kind === 0x80 || kind === 0x90) {
               close(key, tick);
            } else {
               skipped++;
            }
         }
      }
      for (const [key, list] of open) while (list.length) close(key, tick);
      for (const [channel, list] of notes) {
         if (list.length) notes.set(channel, normalizeNotes(list));
         else notes.delete(channel);
      }
      return { name, notes };
   }

   // 1本のトラックに複数のチャンネルがあれば(フォーマット0 など)、名前にチャンネルを添えて見分ける
   const tracks = [...groups.values()].map(({ name, channel, notes, multi }) => ({
      name: multi ? `${name || 'トラック'}(${channel + 1}ch)` : name,
      channel,
      notes,
   }));
   return { tracks, otherMeter, skipped };
}

/** ノートが最後まで収まる小節数(1以上)。読み込んだノートに合わせてクリップを伸ばすのに使う。 */
export function notesBars(notes) {
   const end = Math.max(0, ...normalizeNotes(notes).map((n) => n.start + n.length));
   return Math.max(1, Math.ceil(end / TICKS_PER_BAR));
}

// 書き出すファイルの名前(拡張子なし)。Windows で使えない文字を除く
function exportName(parts) {
   return parts.filter(Boolean).join(' - ').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'clip';
}

/** .mid のファイル名。 */
export const midiFileName = (...parts) => `${exportName(parts)}.mid`;

/** オーディオ(WAV)のファイル名。 */
export const audioFileName = (...parts) => `${exportName(parts)}.wav`;

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

/** General MIDI の音色の系統(8音色ずつ、16系統)。音色を選ぶ画面の見出しと絞り込みに使う。 */
export const GM_FAMILIES = [
   'ピアノ', 'クロマチック・パーカッション', 'オルガン', 'ギター', 'ベース', 'ストリングス', 'アンサンブル', 'ブラス',
   'リード', 'パイプ', 'シンセリード', 'シンセパッド', 'シンセ効果', '民族楽器', '打楽器', '効果音',
];

const searchText = (text) => String(text).normalize('NFKC').toLowerCase();

/**
 * 音色を絞り込む。空白で区切った語がすべて、番号(1始まり)・音色名・系統名のどこかに含まれるものを残す
 * (全角・半角、大文字・小文字は区別しない)。系統ごとにまとめ、1つも残らない系統は返さない。
 * @returns {{ family: string, programs: number[] }[]} programs は 0 始まりの音色番号
 */
export function filterPrograms(query) {
   const terms = searchText(query ?? '').split(/\s+/).filter(Boolean);
   return GM_FAMILIES.map((family, f) => ({
      family,
      programs: Array.from({ length: 8 }, (_, i) => f * 8 + i).filter((program) => {
         const text = searchText(`${program + 1} ${GM_PROGRAMS[program]} ${family}`);
         return terms.every((term) => text.includes(term));
      }),
   })).filter((group) => group.programs.length);
}

/**
 * ドラムキット(10ch のプログラム番号。0 始まり)。Roland GS の並びで、gm.dls(MSGS)が持つのもこの9つ。
 * 音源にない番号を選ぶと、音源(spessasynth)が別のキットで鳴らす。
 */
export const DRUM_KITS = [
   { kit: 0, name: 'Standard' },
   { kit: 8, name: 'Room' },
   { kit: 16, name: 'Power' },
   { kit: 24, name: 'Electronic' },
   { kit: 25, name: 'TR-808' },
   { kit: 32, name: 'Jazz' },
   { kit: 40, name: 'Brush' },
   { kit: 48, name: 'Orchestra' },
   { kit: 56, name: 'SFX' },
];

/** ドラムキットの表示名。一覧にない番号(手で書き換えたデータなど)は番号だけ出す。 */
export function kitLabel(kit) {
   const known = DRUM_KITS.find((k) => k.kit === kit);
   return known ? `${kit + 1}. ${known.name}` : `${kit + 1}. キット`;
}

/** トラックの音色の表示名。 */
export function soundLabel(track) {
   const { program, drum, kit } = trackSound(track);
   return drum ? `ドラム(${kitLabel(kit)})` : `${program + 1}. ${GM_PROGRAMS[program]}`;
}
