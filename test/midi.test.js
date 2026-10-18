// MIDI(ノート、再生、.mid、スケール)のテスト。test/domain.test.js から読む。

import {
   addClip, addMarker, addTrack, canShiftSelection, clearTrackMix, duplicateClip, markerClips, placeClip, setClipNotes,
   shiftSelection, updateTrackMix, updateTrackSound,
} from '../js/domain/arrangement.js';
import {
   audibleNotes, audibleTrackIds, audioFileName, buildMidiFile, clipTickRange, clipTicks, DRUM_CHANNEL, DRUM_KITS, filterPrograms, inScale, kitLabel, MAX_BPM,
   midiFileName, MIN_BPM, moveScale, normalizeBpm, normalizeNotes, normalizeScale, normalizeScales, noteEvents, playbackInput, playbackMessages, PPQ,
   projectBpm, projectScales, removeScale, RENDER_TAIL, renderInput, REVERB_SEND, scaleAt, scaleLabel, scaleSpans, secondsToTicks, setScaleAt, setupMessages, soundLabel,
   TICKS_PER_BAR, ticksToSeconds, trackChannels, trackMix, trackSound, varLen,
} from '../js/domain/midi.js';
import { createProject, updateProject } from '../js/domain/project.js';
import { migrate } from '../js/store/repository.js';
import { test, assert, equal, throws, sampleProject, ids, apply, arrangementFixture, note } from './helpers.js';

// ---- MIDI ----

test('normalizeNotes: 整数に丸めて範囲に収め、開始位置 → 高さの順に並べる', () => {
   equal(normalizeNotes([
      { pitch: 64.4, start: 480, length: 0 }, { pitch: 200, start: -10.6, length: 120, velocity: 0 }, { pitch: 60, start: 480, length: 240 },
   ]), [note(127, -11, 120, 1), note(60, 480, 240), note(64, 480, 1)]);
   equal(normalizeNotes(undefined), [], '項目がなければなし');
});

test('normalizeBpm / projectBpm: 範囲に収め、項目がなければ 120', () => {
   equal([normalizeBpm(128.556), normalizeBpm(5), normalizeBpm(999), normalizeBpm('x'), projectBpm({})], [128.56, MIN_BPM, MAX_BPM, 120, 120]);
   const { project } = createProject({ title: 'x' });
   equal(project.bpm, 120, '新しいプロジェクトは 120');
   equal(updateProject(project, { bpm: '90' }).bpm, 90);
});

test('トラックの音: 既定はピアノ・音量100・パン中央。範囲の外は端に寄せる', () => {
   const track = addTrack('p', [], 'Lead');
   equal(trackSound(track), { program: 0, volume: 100, pan: 64, drum: false, kit: 0 });
   equal(trackSound({}), trackSound(track), '項目がない(v7 以前の)トラック');
   const changed = updateTrackSound(track, { program: 300, pan: -5, drum: true, kit: 200 });
   equal([changed.program, changed.volume, changed.pan, changed.drum, changed.kit, changed.name], [127, 100, 0, true, 127, 'Lead']);
   equal([soundLabel(track), soundLabel(changed)], ['1. Acoustic Grand Piano', 'ドラム(128. キット)']);
});

test('ドラムキット: 10ch にはキットの番号をプログラムチェンジで送る。一覧にない番号は番号だけ出す', () => {
   const track = updateTrackSound(addTrack('p', [], 'Drums'), { program: 5, drum: true, kit: 16 });
   equal(setupMessages(track, 9), [[0xc9, 16], [0xb9, 7, 100], [0xb9, 10, 64]], '音色(5)ではなくキット');
   equal(setupMessages(updateTrackSound(track, { drum: false }), 0)[0], [0xc0, 5], 'ドラムをやめると音色に戻る');
   equal(DRUM_KITS.map((k) => k.kit), [0, 8, 16, 24, 25, 32, 40, 48, 56]);
   equal([kitLabel(16), kitLabel(1)], ['17. Power', '2. キット']);
});

test('ミュート・ソロ・リバーブ: 新しいトラックはミュート・ソロなし、リバーブあり。項目がなくても同じ。音の設定は変えない', () => {
   const track = addTrack('p', [], 'Lead');
   equal(trackMix(track), { mute: false, solo: false, reverb: true });
   equal(trackMix({}), trackMix(track), '項目がない(足す前の)トラック');
   const muted = updateTrackMix(updateTrackSound(track, { volume: 80 }), { mute: 1 });
   equal([muted.mute, muted.solo, muted.volume, muted.name], [true, false, 80, 'Lead']);
   equal(updateTrackMix(muted, { solo: true }).mute, true, '片方だけ変える');
   equal(track.mute, false, '元のレコードは変えない');
   equal(trackMix(updateTrackMix(muted, { reverb: false })), { mute: true, solo: false, reverb: false }, 'リバーブだけ変える');
});

test('リバーブ: 再生ではセンド量(CC91)を送り、OFF なら 0。書き出し(.mid)には入れない', () => {
   const track = addTrack('p', [], 'Lead');
   const dry = updateTrackMix(track, { reverb: false });
   equal(playbackMessages(track, 2), [...setupMessages(track, 2), [0xb2, 91, REVERB_SEND]]);
   equal(playbackMessages(dry, 2).at(-1), [0xb2, 91, 0], 'OFF でも 0 を送る');
   equal(setupMessages(track, 2).some((m) => m[1] === 91), false, '書き出しの設定には入れない');
   const file = buildMidiFile({ bpm: 120, tracks: [track], clips: [] });
   assert(!file.some((b, i) => (b & 0xf0) === 0xb0 && file[i + 1] === 91), '.mid に CC91 がない');
});

test('clearTrackMix: ミュートかソロが ON のトラックだけ、両方を外して返す', () => {
   const plain = addTrack('p', [], 'A');
   const muted = updateTrackMix(addTrack('p', [], 'B'), { mute: true });
   const soloed = updateTrackMix(addTrack('p', [], 'C'), { solo: true, mute: true });
   const cleared = clearTrackMix([plain, muted, soloed]);
   equal(cleared.map((t) => [t.name, t.mute, t.solo]), [['B', false, false], ['C', false, false]]);
   equal(clearTrackMix([plain]), [], '何も ON でなければ空');
   equal(muted.mute, true, '元のレコードは変えない');
});

test('audibleTrackIds: ソロがあればソロだけ、なければミュートしていないもの。alwaysId は必ず鳴らす', () => {
   const [a, b, c] = ['a', 'b', 'c'].map((id) => ({ id }));
   const ids = (tracks, alwaysId) => [...audibleTrackIds(tracks, alwaysId)].sort();
   equal(ids([a, b, c]), ['a', 'b', 'c']);
   equal(ids([{ ...a, mute: true }, b, c]), ['b', 'c']);
   equal(ids([a, { ...b, solo: true }, c]), ['b']);
   equal(ids([a, { ...b, solo: true, mute: true }, { ...c, solo: true }]), ['b', 'c'], 'ソロはミュートより強い');
   equal(ids([{ ...a, mute: true }, b], 'a'), ['a', 'b'], 'ミュートしていても鳴らす');
   equal(ids([a, { ...b, solo: true }], 'a'), ['a', 'b'], 'ほかのトラックがソロでも鳴らす');
   equal(ids([]), []);
});

test('trackChannels: 並び順に 1ch から。10ch はドラム専用で、16本目からは使い回す', () => {
   const tracks = Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, drum: i === 1 }));
   const channels = trackChannels(tracks);
   equal(tracks.slice(0, 12).map((t) => channels.get(t.id)), [0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
   equal([channels.get('t15'), channels.get('t16')], [15, 0], '16本目(ドラムを除いて)で先頭に戻る');
});

test('trackChannels: wrap しなければ、16ch の組を足して全トラックを別のチャンネルにする。ドラムは組ごとの 10ch', () => {
   const tracks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, drum: i === 1 || i === 18 }));
   const channels = trackChannels(tracks, { wrap: false });
   const list = tracks.map((t) => channels.get(t.id));
   equal(new Set(list).size, tracks.length, 'どれも別のチャンネル');
   equal([channels.get('t1'), channels.get('t18')], [9, 25], '2本目のドラムは2組目の 10ch');
   equal([channels.get('t15'), channels.get('t16'), channels.get('t19')], [15, 16, 18], '16本目(ドラムを除いて)から2組目の 1ch');
   assert(list.every((ch) => (ch % 16 === DRUM_CHANNEL) === (ch === 9 || ch === 25)), 'ドラム以外は 10ch を使わない');
});

test('setClipNotes / audibleNotes: 範囲の外のノートは持つが鳴らさない。終わりで切る', () => {
   const { a } = arrangementFixture(); // 4小節
   equal(a.notes, [], '作ったときはノートなし');
   const clip = setClipNotes(a, [note(60, -PPQ), note(62, 0), note(64, 4 * TICKS_PER_BAR - PPQ, 2 * PPQ), note(65, 4 * TICKS_PER_BAR)]);
   equal(clip.notes.length, 4, '範囲の外も持つ');
   equal(audibleNotes(clip), [note(62, 0), note(64, 4 * TICKS_PER_BAR - PPQ, PPQ)]);
   equal(clipTicks(clip), 4 * TICKS_PER_BAR);
});

test('placeClip: 移動ではノートが付いていき、左端の伸縮では曲の中の同じ位置に残る', () => {
   const { clips, a, b } = arrangementFixture();
   const withNotes = setClipNotes(b, [note(60, 0), note(62, TICKS_PER_BAR)]); // 9〜10小節
   const all = apply(clips, [withNotes]);
   equal(placeClip(all, b.id, { startBar: 12 }).notes, withNotes.notes, '移動');
   equal(placeClip(all, b.id, { bars: 4 }).notes, withNotes.notes, '右端の伸縮');
   const shrunk = placeClip(all, b.id, { startBar: 10, bars: 1 });
   equal(shrunk.notes.map((n) => n.start), [-TICKS_PER_BAR, 0], '左端を縮める(手前のノートは消さない)');
   const grown = placeClip(apply(all, [shrunk]), b.id, { startBar: 8, bars: 3 });
   equal(grown.notes.map((n) => n.start), [TICKS_PER_BAR, 2 * TICKS_PER_BAR], '左端を伸ばす');
   equal(a.notes, [], '他のクリップは変えない');
});

test('duplicateClip: 名前・詳細・ノートをコピーした別のクリップを作る。重なる・区間の外には作れない', () => {
   const { project, lane, synth, drums, clips, b } = arrangementFixture();
   const source = { ...setClipNotes(b, [note(60, 0), note(62, TICKS_PER_BAR)]), name: 'フィル', memo: 'メモ' };
   const all = apply(clips, [source]);
   const copy = duplicateClip(source, all, { trackId: drums.id, startBar: 3 });
   assert(copy.id !== source.id, '別の id');
   equal([copy.trackId, copy.startBar, copy.bars, copy.name, copy.memo, copy.notes],
      [drums.id, 3, source.bars, 'フィル', 'メモ', source.notes], '長さは元のまま');
   assert(copy.notes !== source.notes, 'ノートは別の配列(元とつながらない)');
   equal(duplicateClip(source, all, { trackId: synth.id, startBar: 11 }).startBar, 11, '同じトラックの隙間');
   throws(() => duplicateClip(source, all, { trackId: synth.id, startBar: 10 }), '元と重なる');
   const markers = [addMarker(project.id, [], lane('Aメロ'), 9)];
   throws(() => duplicateClip(source, all, { trackId: drums.id, startBar: 1 }, markers), '区間の外');
   equal(duplicateClip(source, all, { trackId: drums.id, startBar: 9 }, markers).startBar, 9);
});

test('shiftSelection: 選んだクリップをまとめて横にずらす。1つでも置けなければどれも動かさない', () => {
   const { project, lane, synth, drums, clips, a, b } = arrangementFixture(); // シンセ 1〜4 と 9〜10
   const c = addClip(drums, [], { startBar: 3, bars: 2 });
   const all = [...clips, c];
   const shift = (clipIds, bars, markers = null) => shiftSelection(all, markers, { clipIds }, bars);
   const can = (clipIds, bars, markers = null) => canShiftSelection(all, markers, { clipIds }, bars);
   const moved = shift([a.id, c.id], 2);
   equal(moved.clips.map((x) => [x.id, x.trackId, x.startBar, x.bars]), [[a.id, synth.id, 3, 4], [c.id, drums.id, 5, 2]], 'トラックは変えない');
   equal(moved.markers, [], 'マーカーは選んでいない');
   equal(a.startBar, 1, '元のレコードは変えない');
   equal(can([a.id, c.id], 2), true);
   equal(can([a.id, c.id], 5), false, 'a が b に重なる');
   throws(() => shift([a.id, c.id], 5), '1つでも重なれば動かさない');
   equal(shift([a.id, b.id], 3).clips.map((x) => x.startBar), [4, 12], '選んだもの同士は互いに邪魔しない');
   equal(can([a.id], -1), false, '1小節目より前');
   const markers = [addMarker(project.id, [], lane('Aメロ'), 9)];
   equal(can([b.id], -4, markers), false, '5〜6小節は区間の外');
   equal(can([b.id], -1, markers), true, '8〜9小節は区間に掛かる');
   equal(can([b.id, a.id], 4, markers), false, 'a(5〜8)が区間の外');
   equal(can(['none'], 1), false, 'ないクリップ');
});

test('markerClips: マーカーの区間に入っているクリップ。またぐものは重なりの多い区間', () => {
   const { project, lane, drums, clips, a, b } = arrangementFixture(); // シンセ 1〜4 と 9〜10
   const c = addClip(drums, [], { startBar: 7, bars: 4 }); // 7〜10
   const d = addClip(drums, [c], { startBar: 11, bars: 4 }); // 11〜14
   const e = addClip(drums, [c, d], { startBar: 30, bars: 2 }); // 30〜31
   const all = [...clips, c, d, e];
   const verse = addMarker(project.id, [], lane('Aメロ'), 1);
   const chorus = addMarker(project.id, [verse], lane('サビ'), 9);
   const verse2 = addMarker(project.id, [chorus], lane('Aメロ'), 14); // 同じセクションの重複(以前のデータ)
   const markers = [verse, chorus, verse2];
   const ids = (markerId) => markerClips(all, markers, markerId).map((x) => x.id);
   equal(ids(verse.id), [a.id, c.id], 'c は 7〜8 と 9〜10 で同数なので、先の区間');
   equal(ids(chorus.id), [b.id, d.id], 'd は 11〜13 と 14 で、多い方');
   equal(ids(verse2.id), [e.id], '同じセクションの別の区間のものは入れない(最後の区間は右端まで続く)');
   equal(markerClips(all, [], verse.id), [], 'マーカーがない');
});

test('shiftSelection: マーカーも一緒にずらす。区間は動かした後のマーカーで判定する', () => {
   const { project, lane, clips, a, b } = arrangementFixture(); // シンセ 1〜4 と 9〜10
   const verse = addMarker(project.id, [], lane('Aメロ'), 1);
   const chorus = addMarker(project.id, [verse], lane('サビ'), 9);
   const markers = [verse, chorus];
   const can = (selection, bars) => canShiftSelection(clips, markers, selection, bars);
   const moved = shiftSelection(clips, markers, { clipIds: [b.id], markerIds: [chorus.id] }, 4);
   equal(moved.clips.map((x) => x.startBar), [13]);
   equal(moved.markers.map((m) => [m.id, m.bar]), [[chorus.id, 13]]);
   equal(chorus.bar, 9, '元のレコードは変えない');
   equal(shiftSelection(clips, markers, { markerIds: [chorus.id] }, 2).clips, [], 'マーカーだけでも動かせる');
   equal(can({ clipIds: [b.id], markerIds: [chorus.id] }, -8), false, '選んでいない Aメロ と同じ小節');
   equal(can({ markerIds: [verse.id, chorus.id] }, -1), false, '1小節目より前');
   equal(can({ clipIds: [a.id, b.id], markerIds: [verse.id, chorus.id] }, 8), true, '選んだもの同士は互いに邪魔しない');
   // 選んでいないクリップは見ない(マーカー1つのドラッグと同じく、区間の外になれば無所属になる)
   equal(can({ markerIds: [verse.id, chorus.id] }, 5), true, '1〜4小節の a が区間の外になっても動かせる');
   equal(can({ clipIds: [a.id], markerIds: [chorus.id] }, -8), false, 'a(-7〜)は1小節目より前');
   equal(can({ clipIds: [a.id], markerIds: [verse.id] }, 2), true, '一緒に動けば区間の中');
   equal(canShiftSelection(clips, [chorus], { clipIds: [b.id], markerIds: [chorus.id] }, -4), true, '一緒に動けば、元の区間の外へも動かせる');
   equal(canShiftSelection(clips, [chorus], { clipIds: [b.id] }, -4), false, 'クリップだけなら区間の外');
   equal(can({ markerIds: ['none'] }, 1), false, 'ないマーカー');
   equal(canShiftSelection(clips, null, { markerIds: [verse.id] }, 1), false, 'マーカーを渡していない');
});

test('filterPrograms: 番号・音色名・系統名で絞り込み、系統ごとにまとめる', () => {
   const all = filterPrograms('');
   equal([all.length, all.flatMap((g) => g.programs).length, all[0].family], [16, 128, 'ピアノ'], '空なら全部');
   equal(filterPrograms('bass').map((g) => g.family), ['ベース', 'ストリングス', 'リード', 'シンセリード'], '音色名の一部(Contrabass、Bassoon も入る)');
   equal(filterPrograms('ＢＡＳＳ　slap').flatMap((g) => g.programs), [36, 37], '全角・大文字、複数の語');
   equal(filterPrograms('ストリングス').flatMap((g) => g.programs), [40, 41, 42, 43, 44, 45, 46, 47], '系統名');
   equal(filterPrograms('128').flatMap((g) => g.programs), [127], '番号');
   equal(filterPrograms('zzz'), [], '合うものがない');
});

test('noteEvents: 曲の頭からの位置で並べ、同じ位置ではノートオフを先に置く', () => {
   const { synth, drums, a, b } = arrangementFixture();
   const tracks = [synth, updateTrackSound(drums, { drum: true })];
   const clips = [
      setClipNotes(a, [note(60, 0), note(60, PPQ)]),
      setClipNotes(b, [note(48, 0, PPQ, 90)]), // 9小節目
      setClipNotes(addClip(drums, [], { startBar: 2, bars: 1 }), [note(36, 0, 60)]),
   ];
   equal(noteEvents({ tracks, clips }), [
      { tick: 0, data: [0x90, 60, 100], port: 0 },
      { tick: PPQ, data: [0x80, 60, 0], port: 0 },
      { tick: PPQ, data: [0x90, 60, 100], port: 0 },
      { tick: 2 * PPQ, data: [0x80, 60, 0], port: 0 },
      { tick: TICKS_PER_BAR, data: [0x99, 36, 100], port: 0 },
      { tick: TICKS_PER_BAR + 60, data: [0x89, 36, 0], port: 0 },
      { tick: 8 * TICKS_PER_BAR, data: [0x90, 48, 90], port: 0 },
      { tick: 8 * TICKS_PER_BAR + PPQ, data: [0x80, 48, 0], port: 0 },
   ]);
   equal(noteEvents({ tracks: [synth], clips }).length, 6, 'トラックのないクリップは鳴らさない');
   equal([ticksToSeconds(TICKS_PER_BAR, 120), secondsToTicks(0.5, 120)], [2, PPQ]);
});

test('playbackInput: 全体はミュートしたトラックを鳴らさず、終わりには数える。ループはそのクリップだけを範囲で', () => {
   const { project, synth, drums, a, b } = arrangementFixture();
   const muted = updateTrackMix(synth, { mute: true });
   const drumClip = setClipNotes(addClip(drums, [], { startBar: 2, bars: 1 }), [note(36, 0, 60)]);
   const clips = [setClipNotes(a, [note(60, 0)]), setClipNotes(b, [note(48, 0)]), drumClip];
   const all = playbackInput({ project, tracks: [muted, drums], clips });
   equal(all.events.map((e) => e.tick), [TICKS_PER_BAR, TICKS_PER_BAR + 60], 'ミュートしたシンセは鳴らさない');
   equal(all.endTick, 8 * TICKS_PER_BAR + PPQ, '終わりはミュートしたトラックの最後の音');
   assert(!all.loop, '全体はループしない');

   const loop = playbackInput({ project, tracks: [muted, drums], clips }, b.id);
   equal(loop.loop, { fromTick: 8 * TICKS_PER_BAR, toTick: 10 * TICKS_PER_BAR }, 'クリップの範囲');
   equal(loop.loop, clipTickRange(b));
   equal(loop.events.map((e) => e.data[1]), [48, 48], 'ミュートしていてもループのクリップは鳴らす');
   equal(loop.setup, playbackMessages(muted, 0).map((data) => ({ data, port: 0 })), 'そのトラックの音色だけを送る');
   equal(playbackInput({ project, tracks: [drums], clips }, b.id), null, 'トラックが消えていたら null');
   equal(playbackInput({ project, tracks: [muted, drums], clips }, 'gone'), null, 'クリップが消えていたら null');
});

test('playbackInput: 16本を超えても、チャンネルを使い回さずに2組目(port 1)で送る', () => {
   const { project, synth, a } = arrangementFixture();
   const tracks = Array.from({ length: 16 }, (_, i) => ({ ...synth, id: `t${i}`, program: i }));
   const clips = [setClipNotes({ ...a, trackId: 't15' }, [note(60, 0)])];
   const input = playbackInput({ project, tracks, clips });
   equal(input.setup.filter((m) => m.data[0] === 0xc0).map((m) => [m.port, m.data[1]]), [[0, 0], [1, 15]], '1ch は1組目と2組目に別の音色');
   equal(input.events.map((e) => [e.port, e.data[0]]), [[1, 0x90], [1, 0x80]], '16本目の音は2組目の 1ch');
   const file = buildMidiFile({ bpm: 120, tracks, clips });
   assert(file.length > 0, '書き出しは 16ch に収める(port は出さない)');
});

// .mid のバイト列を、チャンクごとに読み戻す(テスト用の簡易パーサー)
function parseMidi(bytes) {
   const text = (at) => String.fromCharCode(...bytes.slice(at, at + 4));
   const u32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
   const chunks = [];
   for (let at = 0; at < bytes.length;) {
      const length = u32(at + 4);
      chunks.push({ type: text(at), body: [...bytes.slice(at + 8, at + 8 + length)] });
      at += 8 + length;
   }
   return chunks;
}

test('varLen: 7ビットずつ、続きがあれば最上位ビットを立てる', () => {
   equal([varLen(0), varLen(0x7f), varLen(0x80), varLen(0x3fff), varLen(0x200000)],
      [[0], [0x7f], [0x81, 0x00], [0xff, 0x7f], [0x81, 0x80, 0x80, 0x00]]);
});

test('buildMidiFile: フォーマット1。テンポのトラックと、トラックごとに名前・音色・音量・パン・ノート', () => {
   const { synth, a } = arrangementFixture();
   const track = updateTrackSound(synth, { program: 81, volume: 90, pan: 32 });
   const clip = setClipNotes(placeClip([a], a.id, { startBar: 3 }), [note(60, 0, 0x80)]);
   const chunks = parseMidi(buildMidiFile({ title: 'Song', bpm: 120, tracks: [track], clips: [clip] }));
   equal(chunks.map((c) => c.type), ['MThd', 'MTrk', 'MTrk']);
   equal(chunks[0].body, [0, 1, 0, 2, 0x01, 0xe0], 'フォーマット1、2トラック、480 tick');
   equal(chunks[1].body, [
      0, 0xff, 0x03, 4, ...[...'Song'].map((c) => c.charCodeAt(0)),
      0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 マイクロ秒 = 120 BPM
      0, 0xff, 0x58, 0x04, 4, 2, 24, 8,
      0, 0xff, 0x2f, 0x00,
   ]);
   const name = [...new TextEncoder().encode('シンセ')];
   equal(chunks[2].body, [
      0, 0xff, 0x03, name.length, ...name,
      0, 0xc0, 81, 0, 0xb0, 7, 90, 0, 0xb0, 10, 32,
      ...varLen(2 * TICKS_PER_BAR), 0x90, 60, 100, // 3小節目から
      0x81, 0x00, 0x80, 60, 0,
      0, 0xff, 0x2f, 0x00,
   ]);
   const single = parseMidi(buildMidiFile({ bpm: 120, tracks: [track], clips: [clip], offsetBar: 3 }));
   equal(single[2].body.slice(name.length + 15, name.length + 19), [0, 0x90, 60, 100], 'offsetBar の小節を頭にする');
});

test('midiFileName / audioFileName: 使えない文字とコロンを除く', () => {
   equal(midiFileName('曲: A', 'Lead/1'), '曲_ A - Lead_1.mid');
   equal(midiFileName('', ''), 'clip.mid');
   equal(audioFileName('曲: A'), '曲_ A.wav');
});

test('renderInput: 再生と同じ中身を、曲の頭からのサンプル位置で。長さは再生の終わりに残響のぶんを足す', () => {
   const { project, synth, drums, a } = arrangementFixture();
   const muted = updateTrackMix(synth, { mute: true });
   const drumClip = setClipNotes(addClip(drums, [], { startBar: 2, bars: 1 }), [note(36, 0, PPQ)]);
   const clips = [setClipNotes(a, [note(60, 0, PPQ)]), drumClip];
   const input = renderInput({ project: { ...project, bpm: 120 }, tracks: [muted, drums], clips }, 1000);
   // 120 BPM では 4分音符が 0.5 秒、1小節が 2 秒
   equal(input.events.map((e) => [e.frame, e.data[0] & 0xf0]), [[2000, 0x90], [2500, 0x80]], 'ミュートしたトラックは鳴らさない');
   equal(input.setup, playbackInput({ project, tracks: [muted, drums], clips }).setup, '音色・音量・パン・リバーブは再生と同じ');
   const end = ticksToSeconds(playbackInput({ project, tracks: [muted, drums], clips }).endTick, 120);
   equal(input.frames, Math.round(end * 1000) + RENDER_TAIL * 1000, 'ミュートしたトラックの音まで数えて、残響のぶんを足す');
});

test('migrate: v7 のデータは、BPM 120・ピアノ・ノートなしとして読み込む', () => {
   const data = migrate({
      schemaVersion: 7,
      projects: [{ id: 'p', isTemplate: false }],
      tracks: [{ id: 'tr', projectId: 'p' }],
      clips: [{ id: 'c', projectId: 'p', trackId: 'tr', startBar: 1, bars: 1 }],
   });
   equal(data.projects, [{ id: 'p', bpm: 120, scales: [{ bar: 1, root: 0, mode: 'major' }] }]);
   equal(data.tracks, [{ id: 'tr', projectId: 'p', program: 0, volume: 100, pan: 64, drum: false, kit: 0 }]);
   equal(data.clips[0].notes, []);
});

test('migrate: v8 のデータは1小節目から C メジャー、v9 の scale は1小節目のスケールにする', () => {
   const data = migrate({
      schemaVersion: 9,
      projects: [
         { id: 'p', bpm: 90 },
         { id: 'q', bpm: 90, scale: { root: 21, mode: 'minor' } },
      ],
   });
   equal(data.projects.map((p) => p.scales), [[{ bar: 1, root: 0, mode: 'major' }], [{ bar: 1, root: 9, mode: 'minor' }]]);
   assert(!('scale' in data.projects[1]), 'scale は残さない');
});

test('migrate: v10 のテンプレートは、レーンとタスクごと捨てる', () => {
   const vocal = sampleProject('vocal');
   const data = migrate({
      schemaVersion: 10,
      projects: [{ ...vocal.project, isTemplate: false }, { id: 't', title: '歌モノ', isTemplate: true }],
      lanes: [...vocal.lanes, { id: 'tl', projectId: 't', type: 'global' }],
      tasks: [...vocal.tasks, { id: 'tt', projectId: 't', laneId: 'tl' }],
   });
   equal(data.projects.map((p) => [p.id, 'isTemplate' in p]), [[vocal.project.id, false]], 'isTemplate の項目も消す');
   equal([data.lanes.length, data.tasks.length], [vocal.lanes.length, vocal.tasks.length]);
});

test('migrate: v11 のドラムのトラックは、キットを Standard(0)として読み込む', () => {
   const data = migrate({ schemaVersion: 11, tracks: [{ id: 'tr', projectId: 'p', program: 3, volume: 90, pan: 64, drum: true }] });
   equal([data.tracks[0].kit, data.tracks[0].program, data.tracks[0].drum], [0, 3, true]);
});

test('normalizeScale / normalizeScales: 主音は 0〜11、mode は major か minor。1小節目は必ずある', () => {
   equal([normalizeScale({ root: -3, mode: 'minor' }), normalizeScale(null)], [{ root: 9, mode: 'minor' }, { root: 0, mode: 'major' }]);
   equal(normalizeScales([{ bar: 5, root: 7, mode: 'major' }, { bar: 5, root: 2, mode: 'minor' }]),
      [{ bar: 1, root: 0, mode: 'major' }, { bar: 5, root: 2, mode: 'minor' }], '同じ小節は後のもの');
   equal(projectScales({}), [{ bar: 1, root: 0, mode: 'major' }]);
   const { project } = createProject({ title: 'p' });
   equal(project.scales, [{ bar: 1, root: 0, mode: 'major' }], '新しいプロジェクトは C メジャー');
   equal(updateProject(project, { scales: [{ bar: 1, root: '2', mode: 'minor' }] }).scales, [{ bar: 1, root: 2, mode: 'minor' }]);
});

test('scaleAt / scaleSpans: 転調ごとの区間', () => {
   const scales = [{ bar: 1, root: 0, mode: 'major' }, { bar: 9, root: 2, mode: 'major' }, { bar: 17, root: 9, mode: 'minor' }];
   equal([scaleAt(scales, 8), scaleAt(scales, 9), scaleAt(scales, 30)],
      [{ root: 0, mode: 'major' }, { root: 2, mode: 'major' }, { root: 9, mode: 'minor' }]);
   equal(scaleSpans(scales, 1, 4), [{ from: 0, to: 4, scale: { root: 0, mode: 'major' } }], '転調のないクリップ');
   equal(scaleSpans(scales, 7, 12), [
      { from: 0, to: 2, scale: { root: 0, mode: 'major' } },
      { from: 2, to: 10, scale: { root: 2, mode: 'major' } },
      { from: 10, to: 12, scale: { root: 9, mode: 'minor' } },
   ], '2回転調をまたぐ');
   equal(scaleSpans(scales, 9, 2), [{ from: 0, to: 2, scale: { root: 2, mode: 'major' } }], '頭が転調の小節');
});

test('setScaleAt / moveScale / removeScale', () => {
   const base = normalizeScales([]);
   const added = setScaleAt(base, 5, { root: 7, mode: 'major' });
   equal(added, [{ bar: 1, root: 0, mode: 'major' }, { bar: 5, root: 7, mode: 'major' }]);
   equal(setScaleAt(added, 1, { root: 4, mode: 'minor' })[0], { bar: 1, root: 4, mode: 'minor' }, 'あれば変える');
   equal(moveScale(added, 5, 3).map((s) => s.bar), [1, 3]);
   throws(() => moveScale(added, 1, 3), '1小節目は動かせない');
   throws(() => moveScale(added, 5, 1), 'ほかの転調と同じ小節');
   equal(removeScale(added, 5), base);
   throws(() => removeScale(added, 1), '1小節目は消せない');
   throws(() => removeScale(added, 4), 'ない小節');
   equal(base, [{ bar: 1, root: 0, mode: 'major' }], '受け取ったものは変えない');
});

test('inScale / scaleLabel', () => {
   const pick = (scale) => Array.from({ length: 12 }, (_, i) => 60 + i).filter((p) => inScale(p, scale)).map((p) => p - 60);
   equal(pick({ root: 0, mode: 'major' }), [0, 2, 4, 5, 7, 9, 11], 'C メジャー = 白鍵');
   equal(pick({ root: 9, mode: 'minor' }), [0, 2, 4, 5, 7, 9, 11], 'A マイナーも白鍵');
   equal(pick({ root: 2, mode: 'major' }), [1, 2, 4, 6, 7, 9, 11], 'D メジャー');
   equal(pick({ root: 4, mode: 'minor' }), [0, 2, 4, 6, 7, 9, 11], 'E マイナー');
   assert(inScale(1, { root: 1, mode: 'major' }) && !inScale(2, { root: 1, mode: 'major' }), '低い音でも');
   equal([scaleLabel({ root: 9, mode: 'minor' }), scaleLabel({})], ['A マイナー', 'C メジャー']);
});
