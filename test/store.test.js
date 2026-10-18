// 保存まわり(スキーマの変換、Supabase 実装、ログイン)のテスト。test/domain.test.js から読む。

import { addClip, addMarker, addTrack } from '../js/domain/arrangement.js';
import { createProject } from '../js/domain/project.js';
import { addTask, setStatus } from '../js/domain/task.js';
import { normalizeProjectUrl } from '../js/session.js';
import { checkConnection, createSupabaseRepository, fromRow, toRow } from '../js/store/supabase.js';
import { checkSchema, migrate, NewerSchemaError, SCHEMA_VERSION, upgradeStorage } from '../js/store/repository.js';
import { test, assert, equal, throws, rejects, sampleProject, ids } from './helpers.js';

// ---- store(DOM非依存の部分) ----

test('migrate: 検証して形を揃える', () => {
   const data = migrate(JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects: [{ id: 'p' }] }));
   equal([data.schemaVersion, data.projects.length, data.lanes.length, data.tasks.length], [SCHEMA_VERSION, 1, 0, 0]);
   throws(() => migrate('not json'));
   throws(() => migrate({ projects: [] }), 'schemaVersion なし');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 }), '新しすぎる');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION, tasks: [{}] }), 'id なし');
});

test('migrate: 開始日と終了日を持つ前のデータ(v4)は、日付なしとして読み込む', () => {
   const data = migrate({ schemaVersion: 4, tasks: [{ id: 'a' }, { id: 'b', startDate: '2026-10-20', endDate: null }] });
   equal(data.schemaVersion, SCHEMA_VERSION);
   equal(data.tasks, [
      { id: 'a', startDate: null, endDate: null, clipId: null },
      { id: 'b', startDate: '2026-10-20', endDate: null, clipId: null },
   ]);
});

test('migrate: アレンジを持つ前のデータ(v5)は、アレンジなしとして読み込む', () => {
   const data = migrate({ schemaVersion: 5, projects: [{ id: 'p' }], tasks: [] });
   equal([data.schemaVersion, data.tracks, data.clips, data.markers], [SCHEMA_VERSION, [], [], []]);
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION, clips: [{}] }), 'クリップに id なし');
});

test('migrate: テンプレートの持ち方を変える前のデータは読み込まない', () => {
   for (const schemaVersion of [1, 2, 3]) {
      let message = '';
      try {
         migrate({ schemaVersion, projects: [], templates: [] });
      } catch (error) {
         message = error.message;
      }
      assert(message.includes('古い形式'), `schemaVersion ${schemaVersion}: ${message}`);
   }
});

// ---- store: Supabase 実装 ----

// Supabase の REST API(PostgREST)のふりをする fetch。テーブルをメモリに持ち、
// supabase.js が使う機能(eq / in の絞り込み、data->>項目 の絞り込み、limit と offset、upsert、delete)だけに応える。
function fakeSupabase({ key = 'KEY', failWith = null } = {}) {
   const tables = {};
   const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
   const keyOf = (table, row) => (table === 'app_meta' ? row.key : `${row.collection}/${row.id}`);
   const valueOf = (row, column) => (column.startsWith('data->>') ? row.data?.[column.slice(7)] : row[column]);
   const satisfies = (value, condition) => {
      if (condition.startsWith('in.(')) {
         return condition.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(value));
      }
      return String(value) === condition.replace(/^eq\./, '');
   };
   const fetchImpl = async (input, { method, headers, body }) => {
      const url = new URL(input);
      const table = url.pathname.split('/').pop();
      if (headers.apikey !== key || headers.Authorization !== `Bearer ${key}`) {
         return respond(401, { message: 'Invalid API key' });
      }
      if (failWith) return respond(failWith.status, failWith.body);

      const rows = (tables[table] ??= []);
      const options = ['select', 'order', 'limit', 'offset'];
      const matches = (row) => [...url.searchParams]
         .every(([column, condition]) => options.includes(column) || satisfies(valueOf(row, column), condition));

      if (method === 'GET') {
         const offset = Number(url.searchParams.get('offset') ?? 0);
         const limit = Number(url.searchParams.get('limit') ?? 1000);
         const found = rows.filter(matches).sort((a, b) => (keyOf(table, a) < keyOf(table, b) ? -1 : 1));
         return respond(200, found.slice(offset, offset + limit));
      }
      if (method === 'POST') {
         for (const row of JSON.parse(body)) {
            const i = rows.findIndex((r) => keyOf(table, r) === keyOf(table, row));
            if (i >= 0) rows[i] = { ...rows[i], ...row };
            else rows.push(row);
         }
         return respond(201, null);
      }
      if (method === 'DELETE') {
         tables[table] = rows.filter((row) => !matches(row));
         return respond(204, null);
      }
      return respond(405, { message: method });
   };
   return { tables, repository: createSupabaseRepository({ url: 'https://example.supabase.co', key: 'KEY' }, fetchImpl) };
}

// テーブルに入っている、あるコレクションのレコード
const stored = (tables, collection) => tables.records.filter((r) => r.collection === collection).map((r) => r.data);

test('supabase: レコードは形を問わず data(jsonb)に入れる。列に出すのはコレクション名・id・プロジェクトの id だけ', () => {
   const { project, tasks } = sampleProject('vocal', { title: 'x', dueDate: '2026-10-31' });
   equal(toRow('tasks', tasks[0]), { collection: 'tasks', id: tasks[0].id, project_id: project.id, data: tasks[0] });
   equal(toRow('projects', project).project_id, project.id, 'プロジェクトは自身の id');
   const extra = { ...setStatus(tasks[0], 'done'), removedLater: 1 };
   equal(fromRow(toRow('tasks', extra)), extra, '知らない項目もそのまま往復する');
});

test('supabase: 保存して読み戻せる', async () => {
   const { tables, repository } = fakeSupabase();
   equal(await repository.getProjects(), []);
   const { project, lanes, tasks } = sampleProject('vocal', { title: '曲A', dueDate: '2026-10-31' });
   const other = createProject({ title: '曲B' });
   for (const p of [{ project, lanes, tasks }, other]) {
      await repository.saveProject(p.project);
      await repository.saveLanes(p.lanes);
      await repository.saveTasks(p.tasks);
   }
   equal(await repository.getProject(project.id), project);
   equal(await repository.getProject('missing'), null);
   equal((await repository.getProjects()).map((p) => p.title).sort(), ['曲A', '曲B']);
   equal(ids(await repository.getLanes(project.id)), ids(lanes), 'プロジェクトで絞る');
   equal((await repository.getTasks(project.id)).length, 32);
   equal((await repository.getTasks(other.project.id)).length, 0);

   await repository.saveTask({ ...tasks[0], title: '変更', removedLater: 1 });
   const saved = (await repository.getTasks(project.id)).find((t) => t.id === tasks[0].id);
   equal([saved.title, saved.removedLater, stored(tables, 'tasks').filter((t) => t.projectId === project.id).length],
      ['変更', 1, tasks.length], '同じIDは上書き。知らない項目があっても保存できる');
   await repository.deleteTask(tasks[0].id);
   equal((await repository.getTasks(project.id)).length, tasks.length - 1);

   const track = addTrack(project.id, [], 'ギター');
   const clip = addClip(track, [], { startBar: 1, bars: 2 });
   const marker = addMarker(project.id, [], lanes.find((l) => l.type === 'section'), 3);
   await repository.saveTrack(track);
   await repository.saveClip(clip);
   await repository.saveMarker(marker);
   equal([await repository.getTracks(project.id), await repository.getClips(project.id), await repository.getMarkers(project.id)],
      [[track], [clip], [marker]]);
   equal(await repository.getClips(other.project.id), [], 'プロジェクトで絞る');
   await repository.deleteClip(clip.id);
   await repository.deleteMarker(marker.id);
   equal([(await repository.getClips(project.id)).length, (await repository.getMarkers(project.id)).length], [0, 0]);
});

test('supabase: 削除すると、つながっているレコードも消える', async () => {
   const { tables, repository } = fakeSupabase();
   const save = async ({ project, lanes, tasks }) => {
      await repository.saveProject(project);
      await repository.saveLanes(lanes);
      await repository.saveTasks(tasks);
   };
   const a = sampleProject('vocal', { title: 'A' });
   const b = sampleProject('inst', { title: 'B' });
   await save(a);
   await save(b);
   const section = a.lanes.find((l) => l.type === 'section' && a.tasks.some((t) => t.laneId === l.id));
   const otherSection = b.lanes.find((l) => l.type === 'section');
   const [track, otherTrack] = [addTrack(a.project.id, [], 'ギター'), addTrack(a.project.id, [], 'ベース')];
   await repository.saveTracks([track, otherTrack]);
   await repository.saveClips([addClip(track, [], { startBar: 1, bars: 2 }), addClip(otherTrack, [], { startBar: 1, bars: 2 })]);
   await repository.saveMarkers([addMarker(a.project.id, [], section, 1), addMarker(b.project.id, [], otherSection, 1)]);

   // レーン → そのレーンのタスクとマーカー
   const inSection = a.tasks.filter((t) => t.laneId === section.id).length;
   await repository.deleteLane(section.id);
   equal([(await repository.getTasks(a.project.id)).length, (await repository.getMarkers(a.project.id)).length],
      [a.tasks.length - inSection, 0]);
   equal((await repository.getMarkers(b.project.id)).length, 1, '別のプロジェクトのマーカーは残る');

   // トラック → そのトラックのクリップ
   await repository.deleteTrack(track.id);
   equal((await repository.getClips(a.project.id)).map((c) => c.trackId), [otherTrack.id]);

   // プロジェクト → すべて
   await repository.deleteProject(a.project.id);
   assert(tables.records.every((r) => r.project_id !== a.project.id), 'プロジェクトのレコードが残っていない');
   equal((await repository.getLanes(b.project.id)).length, b.lanes.length, '別のプロジェクトは残る');
});

test('supabase: 1回の上限(1000行)を超えても全部読める', async () => {
   const { repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: 'x' });
   const many = Array.from({ length: 2500 }, (_, i) => ({ ...addTask(lanes[0], [], `t${i}`), order: i }));
   await repository.saveProject(project);
   await repository.saveLanes(lanes);
   await repository.saveTasks(many);
   const read = await repository.getTasks(project.id);
   equal([read.length, new Set(read.map((t) => t.id)).size], [2500, 2500]);
});

test('supabase: エクスポートとインポート(全部置き換える)', async () => {
   const a = fakeSupabase().repository;
   const vocal = sampleProject('vocal', { title: '曲B' });
   await a.saveProject(vocal.project);
   await a.saveLanes(vocal.lanes);
   await a.saveTasks(vocal.tasks);
   const { project, lanes, tasks } = sampleProject('inst', { title: '曲A' });
   await a.saveProject(project);
   await a.saveLanes(lanes);
   await a.saveTasks(tasks);
   const track = addTrack(project.id, [], 'ピアノ');
   const clip = addClip(track, [], { startBar: 5, bars: 4, name: 'リフ' });
   const marker = addMarker(project.id, [], lanes.find((l) => l.type === 'section'), 1);
   await a.saveTracks([track]);
   await a.saveClips([clip]);
   await a.saveMarkers([marker]);
   const exported = await a.exportAll();
   equal([exported.schemaVersion, exported.projects.length, exported.lanes.length, exported.tasks.length],
      [SCHEMA_VERSION, 2, 12 + 5, 32 + 5]);
   equal([exported.tracks, exported.clips, exported.markers], [[track], [clip], [marker]], 'アレンジも含む');

   const { tables, repository: b } = fakeSupabase();
   const old = createProject({ title: '消える' });
   await b.saveProject(old.project);
   await b.saveLanes(old.lanes);
   await b.importAll(JSON.stringify(exported));
   equal((await b.getProjects()).map((p) => p.title).sort(), ['曲A', '曲B']);
   equal((await b.getLanes(old.project.id)).length, 0, '元からあったレコードは消える');
   equal(tables.records.length, 2 + 17 + 37 + 3, '余分な行が残らない');
   equal((await b.getTasks(project.id)).length, tasks.length);
   equal((await b.getTasks(vocal.project.id)).length, 32);
   equal([await b.getTracks(project.id), await b.getClips(project.id), await b.getMarkers(project.id)],
      [[track], [clip], [marker]], 'アレンジも戻る');
   await rejects(b.importAll('{"x":1}'), 'エクスポートデータではありません');
});

test('upgradeStorage: 初めて使う保存先は、変換せずに現在のバージョンを記録する。同じなら何もしない', async () => {
   const { repository } = fakeSupabase();
   equal(await upgradeStorage(repository), false);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   equal(await upgradeStorage(repository), false);
   equal(await checkSchema(repository), SCHEMA_VERSION);
});

test('upgradeStorage: 記録がなく、以前の初期データを入れた印のある保存先は v6 とみなして変換する', async () => {
   const { repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: '曲A' });
   await repository.saveProject({ ...project, isTemplate: false });
   await repository.saveLanes(lanes);
   await repository.saveProject({ id: 'seed-template-vocal', title: '歌モノ', isTemplate: true });
   await repository.setMeta('seeded', true);
   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   equal((await repository.getProjects()).map((p) => p.title), ['曲A'], 'テンプレートは消える');
});

test('upgradeStorage: 古ければ、変換前のデータを残してから変換して保存し直す', async () => {
   const { tables, repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: '曲A' });
   // v4 のタスク(開始日と終了日がない)
   const { startDate, endDate, ...v4task } = setStatus(addTask(lanes[0], [], '作業中'), 'doing');
   await repository.saveProject(project);
   await repository.saveLanes(lanes);
   await repository.saveTasks([v4task]);
   await repository.setMeta('schemaVersion', 4);

   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   const [task] = await repository.getTasks(project.id);
   equal([task.startDate, task.endDate], [null, null], '日付なしとして変換された');
   const backups = tables.app_meta.filter((m) => m.key.startsWith('backup:v4:'));
   equal(backups.length, 1, 'バックアップは1つ');
   equal([backups[0].value.schemaVersion, backups[0].value.tasks], [4, [v4task]], '変換前のまま残る');
   equal(await upgradeStorage(repository), false, '2回目は何もしない');
});

test('upgradeStorage: v8 の保存先は、まとめて今の形に変換する(スケールは1小節目から C メジャー。テンプレートは消える)', async () => {
   const { tables, repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: '曲A' });
   const { scales, ...v8project } = { ...project, bpm: 140 };
   const template = { id: 't', title: 'テンプレート', isTemplate: true };
   await repository.saveProject(v8project);
   await repository.saveProject(template);
   await repository.saveLanes(lanes);
   await repository.setMeta('schemaVersion', 8);

   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   const saved = await repository.getProject(project.id);
   equal([saved.bpm, saved.scales, 'scale' in saved], [140, [{ bar: 1, root: 0, mode: 'major' }], false]);
   equal(await repository.getProject(template.id), null, 'テンプレートは消える');
   equal((await repository.getLanes(project.id)).length, lanes.length, 'ほかのデータはそのまま');
   const backups = tables.app_meta.filter((m) => m.key.startsWith('backup:v8:'));
   equal([backups.length, backups[0].value.projects.find((p) => p.id === project.id).scales], [1, undefined], '変換前のまま残る');
});

test('upgradeStorage: 新しければ止める(何も書き換えない)', async () => {
   const { tables, repository } = fakeSupabase();
   await repository.setMeta('schemaVersion', SCHEMA_VERSION + 1);
   const before = JSON.stringify(tables);
   await rejects(upgradeStorage(repository), '再読み込み');
   await rejects(checkSchema(repository), '再読み込み');
   equal(JSON.stringify(tables), before, '何も書き換えない');
   const error = await checkSchema(repository).catch((e) => e);
   assert(error instanceof NewerSchemaError, 'NewerSchemaError で失敗する');
});

test('supabase: つながらない理由を伝える', async () => {
   const config = { url: 'https://example.supabase.co', key: 'KEY' };
   const using = (options) => {
      const { repository } = fakeSupabase(options);
      return repository.getProjects();
   };
   await rejects(using({ key: 'OTHER' }), '公開キーが正しくありません');
   await rejects(using({ failWith: { status: 401, body: { code: '42501', message: 'permission denied' } } }), '権限がありません');
   await rejects(using({ failWith: { status: 404, body: { code: 'PGRST205', message: 'not found' } } }), 'テーブルが見つかりません');
   await rejects(using({ failWith: { status: 500, body: { message: 'boom' } } }), 'boom');
   await rejects(checkConnection(config, async () => { throw new TypeError('Failed to fetch'); }), '接続できないため、読み込みも保存もできませんでした');
   await checkConnection(config, async () => ({ ok: true, status: 200, json: async () => [] }));
});

test('normalizeProjectUrl: 余分なパスや空白を落とす', () => {
   equal(normalizeProjectUrl('  https://abc.supabase.co/rest/v1/ '), 'https://abc.supabase.co');
   equal(normalizeProjectUrl('http://localhost:54321'), 'http://localhost:54321');
   throws(() => normalizeProjectUrl('abc.supabase.co'), 'スキームなし');
   throws(() => normalizeProjectUrl('http://abc.supabase.co'), 'http');
});
