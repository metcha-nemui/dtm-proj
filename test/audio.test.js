// オーディオトラック(音声の位置、再生・書き出しの中身、パン、波形)のテスト。test/domain.test.js から読む。

import {
   addAudioTrack, addClip, addTrack, assertClipTrack, moveTrackAudio, setTrackAudio, updateTrackMix, updateTrackSound,
} from '../js/domain/arrangement.js';
import {
   arrangementPlayback, arrangementRender, audioEndBar, audioEndTick, audioGain, audioPan, audioPeaks, audioPlayback, audioTicks,
   clampAudioStart, minAudioStart, panMatrix, PEAKS_PER_SECOND, snapToBeat, trackAudio,
} from '../js/domain/audio.js';
import { buildMidiFile, isAudioTrack, PPQ, RENDER_TAIL, TICKS_PER_BAR, trackChannels } from '../js/domain/midi.js';
import { createProject } from '../js/domain/project.js';
import { test, assert, equal, throws, note } from './helpers.js';

// BPM 120 なら、1拍 = 0.5秒、1小節 = 2秒
const FILE = { fileId: 'f1', name: 'vocal.wav', size: 1000, duration: 10 };
const close = (a, b) => Math.abs(a - b) < 1e-9;

function audioFixture() {
   const { project } = createProject({ title: 'x' });
   const synth = addTrack(project.id, [], 'シンセ');
   const vocal = addAudioTrack(project.id, [synth], ' 仮歌 ', FILE);
   return { project, synth, vocal };
}

test('addAudioTrack: 名前は addTrack と同じに決め、音声は曲の頭から。クリップは置けない', () => {
   const { project, synth, vocal } = audioFixture();
   equal([vocal.name, vocal.kind, isAudioTrack(vocal), isAudioTrack(synth), vocal.order > synth.order], ['仮歌', 'audio', true, false, true]);
   equal(trackAudio(vocal), { fileId: 'f1', name: 'vocal.wav', size: 1000, duration: 10, startTick: 0 });
   equal([trackAudio(synth), trackAudio({ kind: 'audio', audio: null })], [null, null], 'MIDI のトラックと、ファイルのないもの');
   equal(addAudioTrack(project.id, [vocal], '', FILE).name, 'Track', '名前が空なら「Track」');
   throws(() => addClip(vocal, [], { startBar: 1 }), 'オーディオトラックには作れない');
   throws(() => assertClipTrack(vocal));
   assertClipTrack(synth);
});

test('setTrackAudio / moveTrackAudio: 選び直しても位置はそのまま。前に出しすぎた位置は収める', () => {
   const { synth, vocal } = audioFixture();
   const moved = moveTrackAudio(vocal, 1234.4, 120);
   equal(trackAudio(moved).startTick, 1234);
   const swapped = setTrackAudio(moved, { fileId: 'f2', name: 'take2.wav', size: 5, duration: 3 });
   equal(trackAudio(swapped), { fileId: 'f2', name: 'take2.wav', size: 5, duration: 3, startTick: 1234 });
   // 10秒 = 20拍。1拍は1小節目より後ろに残す
   equal(trackAudio(moveTrackAudio(vocal, -999999, 120)).startTick, -19 * PPQ);
   throws(() => moveTrackAudio(synth, 0, 120), 'MIDI のトラックは動かせない');
   throws(() => setTrackAudio(synth, FILE));
});

test('位置の計算: 長さは BPM で変わり、拍に丸め、終わる小節を求める', () => {
   const audio = trackAudio(audioFixture().vocal);
   equal([audioTicks(audio, 120), audioTicks(audio, 60)], [20 * PPQ, 10 * PPQ]);
   equal([minAudioStart(audio, 120), minAudioStart({ duration: 0.1 }, 120)], [-19 * PPQ, 0], '1拍より短ければ前に出せない');
   equal([clampAudioStart(audio, 120, 100.6), clampAudioStart(audio, 120, -1e9)], [101, -19 * PPQ]);
   equal([snapToBeat(PPQ * 1.4), snapToBeat(PPQ * 1.6), snapToBeat(-PPQ * 0.6)], [PPQ, PPQ * 2, -PPQ]);
   // 20拍 = 5小節。頭から鳴らせば5小節目で終わり、2拍うしろなら6小節目まで掛かる
   equal([audioEndBar(audio, 120), audioEndBar({ ...audio, startTick: 2 * PPQ }, 120), audioEndBar({ ...audio, startTick: -19 * PPQ }, 120)], [5, 6, 1]);
});

test('audioGain / audioPan: 音量 100 で元の大きさ、2乗の曲線。パンは -1〜1', () => {
   equal([audioGain(100), audioGain(0), audioGain(50)], [1, 0, 0.25]);
   equal([audioPan(64), audioPan(1), audioPan(127), audioPan(0)], [0, -1, 1, -1]);
});

test('panMatrix: StereoPannerNode と同じ式。中央のステレオはそのまま、モノラルは左右に -3dB', () => {
   const center = panMatrix(0, 2);
   assert(close(center.ll, 1) && close(center.rl, 0) && close(center.lr, 0) && close(center.rr, 1), 'ステレオの中央');
   const left = panMatrix(-1, 2);
   assert(close(left.ll, 1) && close(left.rl, 1) && close(left.rr, 0), 'ステレオを左に振り切ると、右も左へ');
   const right = panMatrix(1, 2);
   assert(close(right.ll, 0) && close(right.lr, 1) && close(right.rr, 1), 'ステレオを右に振り切ると、左も右へ');
   const mono = panMatrix(0, 1);
   assert(close(mono.ll, Math.SQRT1_2) && close(mono.lr, Math.SQRT1_2) && mono.rl === 0 && mono.rr === 0, 'モノラルの中央');
});

test('audioPlayback: 聞こえるトラックの音声だけを、秒の位置と倍率で', () => {
   const { project, synth, vocal } = audioFixture();
   const moved = updateTrackSound(moveTrackAudio(vocal, -PPQ, 120), { volume: 50, pan: 127 });
   equal(audioPlayback({ project, tracks: [synth, moved] }), [{ trackId: vocal.id, fileId: 'f1', startSeconds: -0.5, gain: 0.25, pan: 1 }]);
   equal(audioPlayback({ project, tracks: [synth, updateTrackMix(moved, { mute: true })] }), [], 'ミュートは鳴らさない');
   equal(audioPlayback({ project, tracks: [updateTrackMix(synth, { solo: true }), moved] }), [], 'ほかがソロなら鳴らさない');
});

test('arrangementPlayback: 再生の終わりを音声の終わりまで延ばす(ミュートしても)。ループでは鳴らさない', () => {
   const { project, synth, vocal } = audioFixture();
   const clip = { ...addClip(synth, [], { startBar: 1, bars: 1 }), notes: [note(60, 0)] };
   const muted = updateTrackMix(moveTrackAudio(vocal, PPQ, 120), { mute: true });
   const data = { project, tracks: [synth, muted], clips: [clip] };
   equal(audioEndTick(data), 21 * PPQ);
   const input = arrangementPlayback(data);
   equal([input.endTick, input.audio, input.events.length], [21 * PPQ, [], 2]);
   equal(arrangementPlayback({ ...data, tracks: [synth, vocal] }).audio.length, 1);
   equal(arrangementPlayback({ ...data, tracks: [synth, vocal] }, clip.id).audio, [], 'ループ');
   equal(input.setup.length, 4, 'オーディオトラックの音色・音量・パンは音源に送らない');
});

test('arrangementRender: 音声の位置をサンプルの番号に。長さは音声の終わりに残響のぶんを足したところまで', () => {
   const { project, synth, vocal } = audioFixture();
   const input = arrangementRender({ project, tracks: [synth, moveTrackAudio(vocal, -PPQ, 120)], clips: [] }, 1000);
   equal(input.audio.map((a) => [a.frame, a.gain, a.pan]), [[-500, 1, 0]]);
   equal(input.frames, 9500 + RENDER_TAIL * 1000);
   equal(input.events, []);
});

test('トラックのチャンネルと .mid: オーディオトラックは数えず、書き出さない', () => {
   const { project, synth, vocal } = audioFixture();
   const drums = updateTrackSound(addTrack(project.id, [synth, vocal], 'ドラム'), { drum: true });
   const lead = addTrack(project.id, [synth, vocal, drums], 'リード');
   const channels = trackChannels([synth, vocal, drums, lead]);
   equal([channels.get(synth.id), channels.has(vocal.id), channels.get(drums.id), channels.get(lead.id)], [0, false, 9, 1]);
   const withAudio = buildMidiFile({ bpm: 120, tracks: [synth, vocal, lead], clips: [] });
   const without = buildMidiFile({ bpm: 120, tracks: [synth, lead], clips: [] });
   equal([...withAudio], [...without]);
   equal(TICKS_PER_BAR, 4 * PPQ);
});

test('audioPeaks: 1秒に PEAKS_PER_SECOND 個、全チャンネルのいちばん大きな振れ幅を、最大を 255 にして', () => {
   const rate = PEAKS_PER_SECOND * 4; // 4サンプルで1つ
   const left = Float32Array.from([0.1, -0.2, 0, 0, 0, 0.05, 0, 0, 0.5]);
   const right = Float32Array.from([0, 0, 0, 0, -0.1, 0, 0, 0, 0]);
   equal([...audioPeaks([left, right], rate)], [102, 51, 255]);
   equal([...audioPeaks([new Float32Array(4)], rate)], [0], '無音');
   equal([...audioPeaks([], rate)], [], 'チャンネルなし');
});
