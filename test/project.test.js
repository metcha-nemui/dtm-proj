// プロジェクトとレーンのテスト。test/domain.test.js から読む。

import { uniqueTrackName } from '../js/domain/arrangement.js';
import { sortByOrder } from '../js/domain/order.js';
import {
   addSection, assertSection, createProject, daysUntilDue, duplicateLane, moveLane, normalizeDueDate, renameLane, SECTION_COLORS,
   sectionColors, updateProject,
} from '../js/domain/project.js';
import { setStatus } from '../js/domain/task.js';
import { test, assert, equal, throws, sampleProject, sectionNames, titles, ids, apply } from './helpers.js';

// ---- project ----

test('uniqueTrackName: 重複したら番号を振る', () => {
   equal(uniqueTrackName('ドラム', []), 'ドラム');
   equal(uniqueTrackName('ドラム', ['ドラム']), 'ドラム2');
   equal(uniqueTrackName('ドラム', ['ドラム', 'ドラム2']), 'ドラム3');
});

test('createProject: 「全体」レーンだけで作る', () => {
   const { project, lanes, tasks } = createProject({ title: ' 新曲 ', dueDate: '2026-10-31' });
   equal([project.title, project.dueDate, 'isTemplate' in project], ['新曲', '2026-10-31', false]);
   equal(lanes.map((l) => [l.type, l.name, l.projectId]), [['global', '全体', project.id]]);
   equal(tasks, []);
   equal(createProject({ title: '' }).project.title, '無題のプロジェクト');
});

test('「全体」レーンは名前変更・複製・削除できない', () => {
   const { lanes, tasks } = sampleProject('inst');
   const global = lanes.find((l) => l.type === 'global');
   throws(() => renameLane(global, 'ミックス'), '名前変更');
   throws(() => duplicateLane(global.id, lanes, tasks), '複製');
   throws(() => assertSection(global, '削除'), '削除');
   assertSection(lanes.find((l) => l.type === 'section'), '削除');
});

test('updateProject: 空タイトルは拒否', () => {
   const { project } = createProject({ title: 'x' });
   equal(updateProject(project, { title: ' y ', memo: 'm' }).title, 'y');
   throws(() => updateProject(project, { title: '  ' }));
});

test('締切: 作成・編集で持てる。空や不正な日付は締切なし', () => {
   equal(createProject({ title: 'x' }).project.dueDate, null);
   const { project } = createProject({ title: 'x', dueDate: '2026-10-31' });
   equal(project.dueDate, '2026-10-31');
   equal(updateProject(project, { dueDate: '2026-11-05' }).dueDate, '2026-11-05');
   equal(updateProject(project, { dueDate: '' }).dueDate, null);
   equal(updateProject(project, { title: 'y' }).dueDate, '2026-10-31', '他の項目だけ編集しても消えない');
   equal(['2026-02-30', '2026/10/31', 'abc', null, undefined].map(normalizeDueDate), [null, null, null, null, null]);
});

test('daysUntilDue: 端末の日付で数える', () => {
   const today = new Date(2026, 9, 12, 23, 30);
   equal([daysUntilDue('2026-10-12', today), daysUntilDue('2026-10-13', today), daysUntilDue('2026-10-31', today)], [0, 1, 19]);
   equal([daysUntilDue('2026-10-09', today), daysUntilDue('2027-01-01', today), daysUntilDue(null, today)], [-3, 81, null]);
   equal(daysUntilDue('2026-10-13', new Date(2026, 9, 12, 0, 0)), 1, '時刻によらない');
});

test('addSection: 空のセクションを、指定位置か末尾に足す', () => {
   const { project, lanes } = sampleProject('vocal');
   const base = { projectId: project.id, lanes };
   const added = addSection({ ...base, name: ' ブレイク ', index: 1 });
   equal([added.lane.name, added.lane.type], ['ブレイク', 'section']);
   equal(added.lanes.length, 1, '他のレーンは書き換えない');
   equal(sectionNames([...lanes, added.lane]).slice(0, 3), ['イントロ', 'ブレイク', 'Aメロ']);

   const last = addSection(base);
   equal(last.lane.name, 'セクション', '名前を省略したとき');
   equal(sectionNames([...lanes, last.lane]).at(-1), 'セクション');
   equal(addSection({ ...base, name: 'サビ' }).lane.name, 'サビ', '名前が重なっても番号は振らない');
});

test('duplicateLane: タスクごと複製し、ステータスは未着手に戻す', () => {
   const { lanes, tasks } = sampleProject('vocal');
   const source = lanes.find((l) => l.name === 'サビ');
   const worked = tasks.map((t, i) => (t.laneId === source.id
      ? { ...setStatus(t, i % 2 ? 'done' : 'doing'), memo: 'メモ' }
      : t));
   const dup = duplicateLane(source.id, lanes, worked);
   equal(dup.lane.name, 'サビ', '名前は元と同じ');
   equal(dup.tasks.length, 6);
   assert(dup.tasks.every((t) => t.status === 'todo' && t.doneAt === null && t.memo === 'メモ'));
   assert(dup.tasks.every((t) => t.laneId === dup.lane.id && !worked.some((w) => w.id === t.id)));
   equal(titles(dup.tasks), titles(worked.filter((t) => t.laneId === source.id)));
   equal(ids(apply([...lanes, dup.lane], dup.lanes).filter((l) => l.type === 'section')).slice(3, 5), [source.id, dup.lane.id], '元のレーンの直後');
});

test('moveLane: 同じ種類の中だけで並べ替える', () => {
   const { lanes } = sampleProject('inst');
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[0].id, 3));
   equal(sectionNames(moved), ['セクション2', 'セクション3', 'セクション4', 'セクション']);
   equal(moved.find((l) => l.type === 'global').order, lanes.find((l) => l.type === 'global').order);
});

test('sectionColors: 並び順にパレットの色を1色ずつ割り振る。名前が似ていても別の色', () => {
   const { lanes } = sampleProject('vocal');
   const colorOf = (all, name) => sectionColors(all).get(all.find((l) => l.name === name).id);
   const [c1, c2, c3, c4] = SECTION_COLORS;
   equal(['イントロ', 'Aメロ', 'Bメロ', 'サビ'].map((n) => colorOf(lanes, n)), [c1, c2, c3, c4]);
   equal(['Aメロ2', 'サビ2', 'サビ3'].map((n) => colorOf(lanes, n)), [SECTION_COLORS[5], SECTION_COLORS[7], SECTION_COLORS[9]],
      '「サビ」と「サビ2」も別の色');
   equal(colorOf(lanes, 'アウトロ'), SECTION_COLORS[10]);
   assert(!sectionColors(lanes).has(lanes.find((l) => l.type === 'global').id), '「全体」レーンには割り振らない');

   // 並べ替えると、位置に合わせて色が入れ替わる
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[2].id, 1));
   equal(['イントロ', 'Bメロ', 'Aメロ', 'サビ'].map((n) => colorOf(moved, n)), [c1, c2, c3, c4]);
   // 色は位置だけで決まるので、名前を変えても変わらない
   const renamed = apply(lanes, [renameLane(lanes.find((l) => l.name === 'サビ3'), '落ちサビ')]);
   equal(colorOf(renamed, '落ちサビ'), SECTION_COLORS[9]);
});

test('sectionColors: 色を使い切ったら先頭に戻る', () => {
   const lanes = Array.from({ length: SECTION_COLORS.length + 2 }, (_, i) => ({ id: `k${i}`, type: 'section', order: i }));
   const colors = lanes.map((l) => sectionColors(lanes).get(l.id));
   equal(colors.slice(-2), SECTION_COLORS.slice(0, 2));
   equal(new Set(SECTION_COLORS).size, 18, 'パレットは重複のない18色');
});

test('renameLane: 空の名前は拒否', () => {
   const { lanes } = sampleProject('inst');
   const section = lanes.find((l) => l.type === 'section');
   equal(renameLane(section, ' ドロップ ').name, 'ドロップ');
   throws(() => renameLane(section, ''));
});
