// テストの共通部分(登録と実行、比べ方、テストに使うデータ)。各 *.test.js から読む。

import { addClip, addMarker, addTrack, syncClipTasks } from '../js/domain/arrangement.js';
import { PPQ } from '../js/domain/midi.js';
import { sortByOrder } from '../js/domain/order.js';
import { addSection, createProject } from '../js/domain/project.js';
import { addTask } from '../js/domain/task.js';

const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

export function assert(condition, message = 'assertion failed') {
   if (!condition) throw new Error(message);
}

export function equal(actual, expected, label = '') {
   const a = JSON.stringify(actual);
   const e = JSON.stringify(expected);
   assert(a === e, `${label ? `${label}: ` : ''}expected ${e}, got ${a}`);
}

export function throws(fn, label = 'should throw') {
   try {
      fn();
   } catch {
      return;
   }
   throw new Error(label);
}

// promise が、message に part を含むエラーで失敗することを確かめる
export async function rejects(promise, part) {
   try {
      await promise;
   } catch (error) {
      assert(error.message.includes(part), `expected error containing "${part}", got "${error.message}"`);
      return;
   }
   throw new Error(`should reject: ${part}`);
}

// テストに使う構成(以前の初期データのテンプレートと同じ)。sections は [名前, タスク] を並び順どおりに
export const VERSE = ['コード確定', 'メロ確定', 'ドラム', 'ベース'];
export const CHORUS = [...VERSE, '上モノ', 'コーラス'];
export const SAMPLES = {
   vocal: {
      global: ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し'],
      sections: [
         ['イントロ', []], ['Aメロ', VERSE], ['Bメロ', []], ['サビ', CHORUS], ['間奏', []], ['Aメロ2', VERSE],
         ['Bメロ2', []], ['サビ2', CHORUS], ['Cメロ', []], ['サビ3', CHORUS], ['アウトロ', []],
      ],
   },
   inst: {
      global: ['テンポ・キー決定', '仮タイトル', 'ミックス', 'マスタリング', '書き出し'],
      sections: [['セクション', []], ['セクション2', []], ['セクション3', []], ['セクション4', []]],
   },
};
// サンプルの構成で、セクションとタスクの入ったプロジェクトを作る(vocal はレーン12本・タスク32件、inst は5本・5件)
export function sampleProject(key, input = { title: 'x' }) {
   const sample = SAMPLES[key];
   const { project, lanes } = createProject(input);
   const tasks = [];
   const addAll = (lane, list) => {
      for (const title of list) tasks.push(addTask(lane, tasks.filter((t) => t.laneId === lane.id), title));
   };
   addAll(lanes[0], sample.global);
   for (const [name, list] of sample.sections) {
      const { lane } = addSection({ projectId: project.id, lanes, name });
      lanes.push(lane);
      addAll(lane, list);
   }
   return { project, lanes, tasks };
}
export const sectionNames = (lanes) => titles(lanes.filter((l) => l.type === 'section'));
export const titles = (items) => sortByOrder(items).map((i) => i.title ?? i.name);
export const ids = (items) => sortByOrder(items).map((i) => i.id);
export const apply = (items, changed) => items.map((i) => changed.find((c) => c.id === i.id) ?? i);
export const item = (id, order) => ({ id, order });

export function fixture() {
   const { project, lanes, tasks } = sampleProject('vocal');
   const lane = (name) => lanes.find((l) => l.name === name);
   const inLane = (all, name) => sortByOrder(all.filter((t) => t.laneId === lane(name).id));
   return { project, lanes, tasks, lane, inLane };
}

export function arrangementFixture() {
   const { project, lanes } = sampleProject('vocal');
   const lane = (name) => lanes.find((l) => l.name === name);
   const synth = addTrack(project.id, [], 'シンセ');
   const drums = addTrack(project.id, [synth], 'ドラム');
   const a = addClip(synth, [], { startBar: 1, bars: 4, name: ' イントロ ' });
   const b = addClip(synth, [a], { startBar: 9, bars: 2 });
   return { project, lanes, lane, synth, drums, clips: [a, b], a, b };
}

export function linkedFixture() {
   const { project, lanes, tasks } = sampleProject('vocal');
   const lane = (name) => lanes.find((l) => l.name === name);
   const synth = addTrack(project.id, [], 'シンセ');
   const drums = addTrack(project.id, [synth], 'ドラム');
   const intro = addMarker(project.id, [], lane('イントロ'), 1);
   const verse = addMarker(project.id, [intro], lane('Aメロ'), 9);
   const a = addClip(synth, [], { startBar: 1, bars: 4, name: 'イントロ' });
   const c = addClip(drums, [], { startBar: 9, bars: 4, name: 'フィル' });
   const b = addClip(synth, [a], { startBar: 9, bars: 2 });
   const state = { lanes, tracks: [synth, drums], clips: [a, c, b], markers: [intro, verse], tasks };
   // 同期して、保存したあとの状態を返す
   const sync = (s) => {
      const { save, remove } = syncClipTasks(s);
      const added = save.filter((t) => !s.tasks.some((x) => x.id === t.id));
      return { ...s, tasks: [...apply(s.tasks, save), ...added].filter((t) => !remove.includes(t.id)) };
   };
   const linkedTo = (s, clip) => s.tasks.find((t) => t.clipId === clip.id);
   return { project, lane, synth, drums, intro, verse, a, b, c, state, sync, linkedTo };
}

export const note = (pitch, start, length = PPQ, velocity = 100) => ({ pitch, start, length, velocity });

export async function run() {
   const results = [];
   for (const { name, fn } of tests) {
      try {
         await fn();
         results.push({ name, ok: true });
      } catch (error) {
         results.push({ name, ok: false, error: error.message });
      }
   }
   return results;
}

/** コンソール向けの出力。失敗があれば false を返す。 */
export async function report() {
   const results = await run();
   for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.error}`}`);
   const failed = results.filter((r) => !r.ok).length;
   console.log(`\n${results.length - failed}/${results.length} passed`);
   return failed === 0;
}
