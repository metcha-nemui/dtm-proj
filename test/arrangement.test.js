// アレンジと、ボードの連動タスクのテスト。test/domain.test.js から読む。

import {
   addClip, addMarker, addTrack, arrangementBars, canPlace, clipEnd, clipSection, markerSpans, moveTrack, placeClip, renameTrack,
   syncClipTasks, updateClip, updateMarker,
} from '../js/domain/arrangement.js';
import { toDateString } from '../js/domain/date.js';
import { ganttRows } from '../js/domain/gantt.js';
import { duplicateLane } from '../js/domain/project.js';
import { summarize } from '../js/domain/stats.js';
import { moveTask, setStatus, updateTask } from '../js/domain/task.js';
import { migrate } from '../js/store/repository.js';
import { test, assert, equal, throws, titles, apply, arrangementFixture, linkedFixture } from './helpers.js';

// ---- arrangement ----

test('addTrack: 末尾に追加し、名前が重なったら番号を振る。空なら「トラック」', () => {
   const one = addTrack('p', []);
   const two = addTrack('p', [one], ' ');
   const three = addTrack('p', [one, two], 'Bass');
   equal([one.name, two.name, three.name], ['Track', 'Track2', 'Bass']);
   assert(one.order < two.order && two.order < three.order, '末尾に足す');
   equal(titles(apply([one, two, three], moveTrack([one, two, three], three.id, 0))), ['Bass', 'Track', 'Track2']);
   equal(renameTrack(one, ' Lead ').name, 'Lead');
   throws(() => renameTrack(one, ' '), '空の名前は拒否');
});

test('addClip: 同じトラックでは重ならない。別のトラックなら同じ小節に置ける', () => {
   const { synth, drums, clips, a, b } = arrangementFixture();
   equal([a.name, a.memo, a.trackId, clipEnd(a), clipEnd(b)], ['イントロ', '', synth.id, 4, 10]);
   throws(() => addClip(synth, clips, { startBar: 4, bars: 1 }), '終わりの小節に重なる');
   throws(() => addClip(synth, clips, { startBar: 7, bars: 3 }), '後ろのクリップに重なる');
   equal(addClip(synth, clips, { startBar: 5, bars: 4 }).startBar, 5, 'ちょうど隙間に収まる');
   equal(addClip(drums, clips, { startBar: 1, bars: 16 }).trackId, drums.id, '別のトラック');
   throws(() => addClip(synth, [], { startBar: 0, bars: 1 }), '0小節目はない');
   throws(() => addClip(synth, [], { startBar: 1, bars: 0 }), '長さは1以上');
   throws(() => addClip(synth, [], { startBar: 1.5, bars: 1 }), '整数だけ');
   equal(canPlace(clips, { trackId: synth.id, startBar: 3, bars: 2 }, a.id), true, '自分自身とは重ならない');
});

test('placeClip: 移動・伸縮・トラック間の移動。重なるなら拒否', () => {
   const { synth, drums, clips, a, b } = arrangementFixture();
   equal([placeClip(clips, a.id, { startBar: 3 }).startBar, placeClip(clips, a.id, { bars: 8 }).bars], [3, 8]);
   throws(() => placeClip(clips, a.id, { startBar: 7 }), '移動先が重なる');
   throws(() => placeClip(clips, a.id, { bars: 9 }), '伸ばすと重なる');
   const moved = placeClip(clips, b.id, { trackId: drums.id, startBar: 1 });
   equal([moved.trackId, moved.startBar, moved.bars, moved.name], [drums.id, 1, 2, b.name], '別のトラックへ');
   equal(clips.find((c) => c.id === b.id).trackId, synth.id, '元のレコードは変えない');
   equal(updateClip(a, { name: ' ', memo: 'メモ' }), { ...a, name: '', memo: 'メモ', updatedAt: updateClip(a, {}).updatedAt });
});

test('マーカー: セクションを指し、同じ小節・同じセクションには1つだけ。「全体」レーンは置けない', () => {
   const { project, lanes, lane } = arrangementFixture();
   const intro = addMarker(project.id, [], lane('イントロ'), 1);
   const verse = addMarker(project.id, [intro], lane('Aメロ'), 9);
   throws(() => addMarker(project.id, [intro, verse], lane('Bメロ'), 9), '同じ小節');
   throws(() => addMarker(project.id, [], lanes.find((l) => l.type === 'global'), 5), '全体レーン');
   throws(() => addMarker(project.id, [], lane('Bメロ'), 0), '0小節目');
   throws(() => addMarker(project.id, [intro, verse], lane('Aメロ'), 17), '同じセクション');
   const markers = [verse, intro];
   const spans = markerSpans(markers, lanes, 32);
   equal(spans.map((s) => [s.lane.name, s.from, s.to]), [['イントロ', 1, 8], ['Aメロ', 9, 32]], '次のマーカーの手前まで');

   throws(() => updateMarker(markers, verse.id, { bar: 1 }), '移動先にマーカーがある');
   equal(updateMarker(markers, verse.id, { bar: 9 }).bar, 9, '自分の小節には置ける');
   const changed = updateMarker(markers, verse.id, { bar: 17, lane: lane('サビ') });
   equal([changed.bar, changed.laneId], [17, lane('サビ').id]);
   throws(() => updateMarker(markers, verse.id, { lane: lane('イントロ') }), 'ほかのマーカーが指すセクション');
   equal(updateMarker(markers, verse.id, { lane: lane('Aメロ') }).laneId, lane('Aメロ').id, '自分のセクションのまま');
   // 以前のデータには同じセクションのマーカーが重複していることがある。消さずに、動かすことはできる
   const twin = { ...addMarker(project.id, [], lane('Aメロ'), 25), id: 'twin' };
   equal(updateMarker([...markers, twin], twin.id, { bar: 29 }).bar, 29, '重複したマーカーも動かせる');
});

test('arrangementBars: 中身の後ろに余白を取り、4小節単位で伸びる', () => {
   const { clips } = arrangementFixture();
   equal(arrangementBars([], []), 32, '空なら32小節');
   equal(arrangementBars(clips, []), 32, '短いうちは32小節');
   equal(arrangementBars([{ startBar: 30, bars: 3 }], []), 40, '32小節目まで + 余白8');
   equal(arrangementBars([{ startBar: 30, bars: 4 }], []), 44, '33小節目まで + 余白8 を4の倍数に切り上げ');
   equal(arrangementBars([], [{ bar: 41 }]), 52, 'マーカーも数える');
});

// ---- アレンジとボードの連動タスク ----

test('clipSection: 重なる小節がいちばん多いセクション。同じセクションの重複(以前のデータ)は合計し、同数なら先のもの', () => {
   const { project, lanes, lane } = arrangementFixture();
   const markers = [
      addMarker(project.id, [], lane('イントロ'), 1),
      addMarker(project.id, [], lane('Aメロ'), 9),
      addMarker(project.id, [], lane('サビ'), 17),
      addMarker(project.id, [], lane('Aメロ'), 25),
   ];
   const at = (startBar, bars) => clipSection({ startBar, bars }, markers);
   const name = (laneId) => lanes.find((l) => l.id === laneId)?.name ?? null;
   equal(name(at(1, 4)), 'イントロ', '1つの区間に収まる');
   equal(name(at(6, 7)), 'Aメロ', 'イントロ3小節、Aメロ4小節');
   equal(name(at(5, 8)), 'イントロ', '4小節ずつなら先の区間');
   equal(name(at(15, 16)), 'Aメロ', 'Aメロ 2+6 とサビ 8 は同数で、先に出てくる Aメロ');
   equal(name(at(40, 4)), 'Aメロ', '最後のマーカーは終わりなく続く');
   const late = [addMarker(project.id, [], lane('Bメロ'), 5)];
   equal(clipSection({ startBar: 1, bars: 4 }, late), null, 'マーカーより前は無所属');
   equal(name(clipSection({ startBar: 3, bars: 4 }, late)), 'Bメロ', '一部がはみ出していても、重なっていれば所属');
   equal(clipSection({ startBar: 1, bars: 4 }, []), null, 'マーカーがなければ無所属');
});

test('canPlace / addClip / placeClip: マーカーを渡すと、セクションの区間の外には置けない', () => {
   const { project, synth, lane, clips, a } = arrangementFixture();
   const markers = [addMarker(project.id, [], lane('Aメロ'), 9)];
   const place = (startBar, bars) => ({ trackId: synth.id, startBar, bars });
   equal(canPlace([], place(1, 4), null, markers), false, '区間の外');
   equal(canPlace([], place(6, 4), null, markers), true, '一部がはみ出すのはよい');
   equal(canPlace([], place(1, 4)), true, 'マーカーを渡さなければ、区間は見ない');
   throws(() => addClip(synth, [], { startBar: 1, bars: 2 }, markers), '区間の外には作れない');
   throws(() => addClip(synth, [], { startBar: 20, bars: 2 }, []), 'マーカーがなければ作れない');
   equal(addClip(synth, [], { startBar: 20, bars: 2 }, markers).startBar, 20);
   throws(() => placeClip(clips, a.id, { startBar: 2 }, markers), '区間の外へは動かせない');
   equal(placeClip(clips, a.id, { startBar: 11 }, markers).startBar, 11, '区間の中へは動かせる');
});

test('syncClipTasks: セクションのレーンの末尾に「トラック名: クリップ名」で作る。何度呼んでも同じ', () => {
   const { lane, a, b, c, state, sync, linkedTo } = linkedFixture();
   const synced = sync(state);
   equal([linkedTo(synced, a).title, linkedTo(synced, b).title, linkedTo(synced, c).title],
      ['シンセ: イントロ', 'シンセ: (無題)', 'ドラム: フィル']);
   equal([linkedTo(synced, a).laneId, linkedTo(synced, b).laneId], [lane('イントロ').id, lane('Aメロ').id]);
   equal([linkedTo(synced, a).status, linkedTo(synced, a).clipId], ['todo', a.id]);
   const verseTitles = titles(synced.tasks.filter((t) => t.laneId === lane('Aメロ').id));
   equal(verseTitles.slice(-2), ['シンセ: (無題)', 'ドラム: フィル'], 'ふつうのタスクの後ろに、トラックの順で並ぶ');
   equal(syncClipTasks(synced), { save: [], remove: [] }, '揃っていれば何もしない');
});

test('syncClipTasks: 名前・詳細・所属の変更を反映し、ステータスは残す', () => {
   const { project, lane, synth, a, b, verse, state, sync, linkedTo } = linkedFixture();
   let s = sync(state);
   s = { ...s, tasks: apply(s.tasks, [setStatus(linkedTo(s, b), 'doing')]) };

   s = sync({ ...s, tracks: [renameTrack(synth, 'Lead'), s.tracks[1]], clips: apply(s.clips, [updateClip(a, { name: '', memo: 'm' })]) });
   equal([linkedTo(s, a).title, linkedTo(s, a).memo], ['Lead: (無題)', 'm'], 'トラック名・クリップ名・詳細');

   // Aメロのマーカーを後ろへずらすと、9〜10小節目のクリップはイントロに入る(9〜12小節目のフィルも、2小節ずつで先のイントロへ)
   s = sync({ ...s, markers: apply(s.markers, [updateMarker(s.markers, verse.id, { bar: 11 })]) });
   const moved = linkedTo(s, b);
   equal([moved.laneId, moved.status], [lane('イントロ').id, 'doing'], '別のセクションへ移っても状態は残る');
   equal(titles(s.tasks.filter((t) => t.laneId === lane('イントロ').id)).slice(-2), [moved.title, 'ドラム: フィル'], '移った先の末尾');

   // マーカーを全部消すと無所属。ボードにも集計にも出ない
   s = sync({ ...s, markers: [] });
   equal(s.tasks.filter((t) => t.clipId).map((t) => t.laneId), [null, null, null]);
   equal(summarize(s.tasks).total, s.tasks.filter((t) => !t.clipId).length, '無所属は数えない');
   equal(ganttRows(s.tasks, s.lanes, toDateString(new Date())), [], '無所属はガントチャートにも出ない');

   // マーカーを置き直すと、元の状態で戻る
   s = sync({ ...s, markers: [addMarker(project.id, [], lane('サビ'), 1)] });
   equal([linkedTo(s, b).laneId, linkedTo(s, b).status], [lane('サビ').id, 'doing']);
});

test('syncClipTasks: クリップがなくなれば消す。同じクリップに2つあれば古い方を残す', () => {
   const { a, b, state, sync, linkedTo } = linkedFixture();
   const s = sync(state);
   const task = linkedTo(s, a);
   equal(syncClipTasks({ ...s, clips: s.clips.filter((c) => c.id !== a.id) }).remove, [task.id]);
   const twin = { ...linkedTo(s, b), id: 'twin', createdAt: '9999-01-01T00:00:00.000Z' };
   equal(syncClipTasks({ ...s, tasks: [...s.tasks, twin] }).remove, ['twin']);
});

test('連動タスク: 別のレーンへは動かせず、名前はクリップで変える。複製にはコピーしない', () => {
   const { lane, a, state, sync, linkedTo } = linkedFixture();
   const s = sync(state);
   const task = linkedTo(s, a);
   throws(() => moveTask(s.tasks, task.id, lane('サビ').id, 0), '別のセクションへ');
   equal(moveTask(s.tasks, task.id, task.laneId, 0)[0].laneId, task.laneId, 'レーンの中では並べ替えられる');
   throws(() => updateTask(task, { title: 'x' }), 'タイトルは変えられない');
   equal(updateTask(task, { references: ['Lemon'] }).references, ['Lemon']);
   equal(duplicateLane(lane('イントロ').id, s.lanes, s.tasks).tasks.some((t) => t.title.startsWith('シンセ')), false, 'セクションの複製');
});

test('migrate: v6 のデータは、セクションに入っているクリップに連動タスクを作る', () => {
   const { project, lane, a, state } = linkedFixture();
   const outside = { ...a, id: 'outside', startBar: 1, bars: 1, trackId: state.tracks[1].id };
   const markers = state.markers.filter((m) => m.laneId === lane('Aメロ').id); // イントロのマーカーなし
   const data = migrate({
      schemaVersion: 6, projects: [project], lanes: state.lanes, tasks: state.tasks,
      tracks: state.tracks, clips: [...state.clips, outside], markers,
   });
   const linked = data.tasks.filter((t) => t.clipId);
   equal(linked.map((t) => t.title).sort(), ['シンセ: (無題)', 'ドラム: フィル'], '区間の外のクリップには作らない');
   equal(data.tasks.filter((t) => !t.clipId).every((t) => t.clipId === null), true, 'ふつうのタスクは clipId: null');
   equal(migrate(data).tasks.length, data.tasks.length, 'v7 のデータには足さない');
});
