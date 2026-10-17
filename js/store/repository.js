// repository のインターフェース定義と、その共通の実装。
// UIとドメインロジックはここで定義したメソッドだけを使う。
// 保存先ごとの実装(indexeddb.js と supabase.js)は「文書ストア」(DocumentStore)の基本操作だけを持ち、
// repository はその上に createRepository で1回だけ組み立てる。連鎖削除やスキーマの変換を二重に持たないため。
// すべて非同期(Promise)で、実装を差し替えてもシグネチャは変えない。

import { syncClipTasks } from '../domain/arrangement.js';
import { normalizeNotes, normalizeScales, projectBpm, trackSound } from '../domain/midi.js';

// v4: テンプレートをプロジェクトと同じ形(isTemplate の付いたプロジェクト)で持つようにし、
// セクション種別と定番タスクをやめた。それより前のデータは形が違い、変換を用意していないので読み込めない。
// v5: タスクに開始日と終了日(startDate / endDate)を足した。v4 のデータは、日付なしとして読み込む。
// v6: アレンジ(トラック・クリップ・マーカー)を足した。v4・v5 のデータは、アレンジなしとして読み込む。
// v7: クリップをボードのタスク(連動タスク。clipId を持つ)として出すようにした。
// v6 以前のデータは、セクションに入っているクリップに連動タスクを作って読み込む。
// v8: クリップを MIDI クリップにした(プロジェクトの BPM、トラックの音色・音量・パン、クリップのノート)。
// v7 以前のデータは、BPM 120、ピアノ・音量 100・パン中央、ノートなしとして読み込む。
// v9: プロジェクトにスケール(scale。キーとメジャー / マイナー。ピアノロールの塗り分け)を足した。
// v10: 途中の転調のため、スケールを小節ごとの並び(scales)にした。v9 の scale は1小節目のスケールにし、
// v8 以前のデータは1小節目から C メジャーとして読み込む。
export const SCHEMA_VERSION = 10;
const OLDEST_READABLE_VERSION = 4;
// 保存先に schemaVersion を記録し始めたときのバージョン。記録がない保存先は、このバージョンのデータとみなす
const UNTRACKED_VERSION = 6;

/**
 * プロジェクトも、テンプレートも Project として扱う。テンプレートは「ステータスを使わないプロジェクト」で、
 * レーンとタスクの持ち方は同じ。プロジェクトは、どのテンプレートから作ったかを覚えない。
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} title テンプレートでは、テンプレートの名前
 * @property {string} memo
 * @property {string|null} dueDate 締切(YYYY-MM-DD)。なければ null。テンプレートでは使わない
 * @property {boolean} isTemplate
 * @property {number} [bpm] アレンジの再生と書き出しのテンポ(拍子は 4/4 固定)。プロジェクトだけが持つ
 * @property {Array<{ bar: number, root: number, mode: 'major'|'minor' }>} [scales] ピアノロールの行の塗り分けに使うキー(root は 0 = C)。
 *    小節の順に並び、1小節目のものが必ずある。次の転調まで続く。プロジェクトだけが持つ
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * セクションも「全体」レーンも Lane として扱う。「全体」(type='global')は各プロジェクトに必ず1本ある。
 * @typedef {Object} Lane
 * @property {string} id
 * @property {string} projectId
 * @property {'section'|'global'} type
 * @property {string} name
 * @property {number} order
 * @property {boolean} collapsed
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} projectId
 * @property {string|null} laneId null になるのは、セクションから外れた連動タスクだけ(ボードにも集計にも出さない)
 * @property {string} title 連動タスクでは「トラック名: クリップ名」(クリップから写す)
 * @property {string} memo 連動タスクでは、クリップの詳細を写したもの
 * @property {string|null} clipId アレンジのクリップから作った連動タスクなら、そのクリップのID。ふつうのタスクは null
 * @property {'todo'|'doing'|'done'} status テンプレートでは使わない(常に 'todo')
 * @property {number} order
 * @property {string|null} doneAt
 * @property {string|null} startDate 開始日(YYYY-MM-DD)。なければ null。テンプレートでは使わない(常に null)
 * @property {string|null} endDate 終了日(YYYY-MM-DD)。なければ null。テンプレートでは使わない(常に null)
 * @property {string[]} [references] リファレンス(参考にする楽曲の曲名)。項目がなければなし。テンプレートでは使わない(常に空)
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * アレンジ画面のトラック。プロジェクトだけが持つ(テンプレートは持たず、コピーもしない)。
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} projectId
 * @property {string} name
 * @property {number} order
 * @property {number} program 音色(General MIDI のプログラム番号。0〜127)。drum なら使わない
 * @property {number} volume 音量(0〜127)
 * @property {number} pan パン(0〜127。64 が中央)
 * @property {boolean} drum ドラムのトラック(10ch で鳴らす)
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * ピアノロールのノート。位置はクリップの先頭からの相対で、単位は tick(4分音符 = 480)。
 * クリップの範囲の外にはみ出したもの(start が負のものも)は、持っていても鳴らさない。
 * @typedef {Object} Note
 * @property {number} pitch 0〜127(60 が C4)
 * @property {number} start
 * @property {number} length 1以上
 * @property {number} velocity 1〜127
 */

/**
 * トラックに置くクリップ。startBar 小節目から bars 小節ぶんを占める。同じトラックのクリップどうしは重ならない。
 * 属するセクション(マーカーの区間と重なる小節がいちばん多いもの)のレーンに、連動タスクとして出る。
 * @typedef {Object} Clip
 * @property {string} id
 * @property {string} projectId
 * @property {string} trackId
 * @property {string} name 空でもよい
 * @property {string} memo 詳細
 * @property {number} startBar 1始まりの整数
 * @property {number} bars 1以上の整数
 * @property {Note[]} notes 開始位置の順
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * セクションマーカー。ボードのセクション(レーン)を指し、名前と色はレーンのものを使う。
 * bar 小節目から、次のマーカーの手前までがそのセクション。同じ小節には1つだけ。
 * @typedef {Object} Marker
 * @property {string} id
 * @property {string} projectId
 * @property {string} laneId
 * @property {number} bar 1始まりの整数
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ExportData
 * @property {number} schemaVersion
 * @property {string} exportedAt
 * @property {Project[]} projects テンプレートも含む
 * @property {Lane[]} lanes
 * @property {Task[]} tasks
 * @property {Track[]} tracks
 * @property {Clip[]} clips
 * @property {Marker[]} markers
 */

/**
 * @typedef {Object} Repository
 * @property {() => Promise<Project[]>} getProjects テンプレートは含めない
 * @property {() => Promise<Project[]>} getTemplates テンプレートだけ
 * @property {(id: string) => Promise<Project|null>} getProject プロジェクトでもテンプレートでも
 * @property {(p: Project) => Promise<void>} saveProject
 * @property {(id: string) => Promise<void>} deleteProject レーンとタスク、アレンジも一緒に消す
 *
 * @property {(projectId: string) => Promise<Lane[]>} getLanes
 * @property {(l: Lane) => Promise<void>} saveLane
 * @property {(ls: Lane[]) => Promise<void>} saveLanes
 * @property {(id: string) => Promise<void>} deleteLane レーン内のタスクと、レーンを指すマーカーも一緒に消す
 *
 * @property {(projectId: string) => Promise<Task[]>} getTasks
 * @property {(t: Task) => Promise<void>} saveTask
 * @property {(ts: Task[]) => Promise<void>} saveTasks
 * @property {(id: string) => Promise<void>} deleteTask
 *
 * @property {(projectId: string) => Promise<Track[]>} getTracks
 * @property {(t: Track) => Promise<void>} saveTrack
 * @property {(ts: Track[]) => Promise<void>} saveTracks
 * @property {(id: string) => Promise<void>} deleteTrack トラックのクリップも一緒に消す
 *
 * @property {(projectId: string) => Promise<Clip[]>} getClips
 * @property {(c: Clip) => Promise<void>} saveClip
 * @property {(cs: Clip[]) => Promise<void>} saveClips
 * @property {(id: string) => Promise<void>} deleteClip
 *
 * @property {(projectId: string) => Promise<Marker[]>} getMarkers
 * @property {(m: Marker) => Promise<void>} saveMarker
 * @property {(ms: Marker[]) => Promise<void>} saveMarkers
 * @property {(id: string) => Promise<void>} deleteMarker
 *
 * @property {(key: string) => Promise<any>} getMeta アプリ内部の状態(シード済みフラグなど)
 * @property {(key: string, value: any) => Promise<void>} setMeta
 *
 * @property {() => Promise<ExportData>} exportAll
 * @property {(json: string|object) => Promise<void>} importAll 既存データをすべて置き換える
 */

/**
 * 保存先ごとに用意する基本操作。レコードは JSON のまま出し入れし、項目の形は知らない
 * (項目を足したり変えたりしても、保存先の作り直しが要らないようにするため)。
 * filter は1項目の一致だけ。使う項目は id、projectId、laneId、trackId。
 * @typedef {Object} DocumentStore
 * @property {(collection: string, filter?: Object<string, string>) => Promise<Object[]>} find filter がなければ全件
 * @property {(collection: string, id: string) => Promise<Object|null>} get
 * @property {(collection: string, records: Object[]) => Promise<void>} put あれば上書き、なければ追加
 * @property {(collection: string, filter: Object<string, string>) => Promise<void>} remove
 * @property {(key: string) => Promise<any>} getMeta
 * @property {(key: string, value: any) => Promise<void>} setMeta
 * @property {(data: ExportData) => Promise<void>} replaceAll 全コレクションの中身を data に置き換える
 */

export const COLLECTIONS = ['projects', 'lanes', 'tasks', 'tracks', 'clips', 'markers'];

const METHODS = [
   'getProjects', 'getTemplates', 'getProject', 'saveProject', 'deleteProject',
   'getLanes', 'saveLane', 'saveLanes', 'deleteLane',
   'getTasks', 'saveTask', 'saveTasks', 'deleteTask',
   'getTracks', 'saveTrack', 'saveTracks', 'deleteTrack',
   'getClips', 'saveClip', 'saveClips', 'deleteClip',
   'getMarkers', 'saveMarker', 'saveMarkers', 'deleteMarker',
   'getMeta', 'setMeta',
   'exportAll', 'importAll',
];

/** 実装がインターフェースを満たしているか起動時に確かめる。 */
export function assertRepository(impl) {
   const missing = METHODS.filter((name) => typeof impl?.[name] !== 'function');
   if (missing.length) throw new Error(`repository に未実装のメソッドがあります: ${missing.join(', ')}`);
   return impl;
}

/**
 * 文書ストアの上に repository を組み立てる。
 * @param {DocumentStore} store
 * @returns {Repository}
 */
export function createRepository(store) {
   const ofProject = (name) => (projectId) => store.find(name, { projectId });
   const saveOne = (name) => (record) => store.put(name, [record]);
   const saveMany = (name) => (records) => store.put(name, records);
   const removeById = (name) => (id) => store.remove(name, { id });
   // 子を先に消し、親は最後に消す。途中で失敗しても親が残るので、もう一度消せば揃う
   // (先に親を消すと、どこからも見えない子が残り、進捗の集計などに混ざる)
   const removeWithChildren = async (name, id, children) => {
      await Promise.all(children.map(([child, field]) => store.remove(child, { [field]: id })));
      await store.remove(name, { id });
   };

   return assertRepository({
      // プロジェクトとテンプレートは同じコレクションに入っている(件数が少ないので、読んでから振り分ける)
      getProjects: async () => (await store.find('projects')).filter((p) => !p.isTemplate),
      getTemplates: async () => (await store.find('projects')).filter((p) => p.isTemplate),
      getProject: (id) => store.get('projects', id),
      saveProject: saveOne('projects'),
      deleteProject: (id) => removeWithChildren('projects', id,
         COLLECTIONS.filter((name) => name !== 'projects').map((name) => [name, 'projectId'])),

      getLanes: ofProject('lanes'),
      saveLane: saveOne('lanes'),
      saveLanes: saveMany('lanes'),
      deleteLane: (id) => removeWithChildren('lanes', id, [['tasks', 'laneId'], ['markers', 'laneId']]),

      getTasks: ofProject('tasks'),
      saveTask: saveOne('tasks'),
      saveTasks: saveMany('tasks'),
      deleteTask: removeById('tasks'),

      getTracks: ofProject('tracks'),
      saveTrack: saveOne('tracks'),
      saveTracks: saveMany('tracks'),
      deleteTrack: (id) => removeWithChildren('tracks', id, [['clips', 'trackId']]),

      getClips: ofProject('clips'),
      saveClip: saveOne('clips'),
      saveClips: saveMany('clips'),
      deleteClip: removeById('clips'),

      getMarkers: ofProject('markers'),
      saveMarker: saveOne('markers'),
      saveMarkers: saveMany('markers'),
      deleteMarker: removeById('markers'),

      getMeta: (key) => store.getMeta(key),
      setMeta: (key, value) => store.setMeta(key, value),

      async exportAll() {
         const lists = await Promise.all(COLLECTIONS.map((name) => store.find(name)));
         const data = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
         COLLECTIONS.forEach((name, i) => { data[name] = lists[i]; });
         return data;
      },

      async importAll(json) {
         await store.replaceAll(migrate(json));
         // インポート後に初期データを重ねて投入しないようにする
         await store.setMeta('seeded', true);
      },
   });
}

// ---- 保存先のスキーマバージョン ----
// 保存先には、データ全体で1つの schemaVersion を記録する(meta の 'schemaVersion')。
// アプリより古ければ起動時に変換して保存し直し、新しければ書き込ませずに止める。

/** 保存先のデータがアプリより新しい(古いアプリが開いたままになっている、など)。 */
export class NewerSchemaError extends Error {
   constructor(version) {
      super(`データがこのアプリより新しい形式になっています(schemaVersion ${version})。ページを再読み込みしてください`);
      this.name = 'NewerSchemaError';
   }
}

/**
 * 保存先のスキーマバージョンを確かめる。アプリより新しければ NewerSchemaError で失敗する。
 * @param {Repository} repository
 * @returns {Promise<number>} 保存先のバージョン
 */
export async function checkSchema(repository) {
   return notNewer((await repository.getMeta('schemaVersion')) ?? UNTRACKED_VERSION);
}

function notNewer(version) {
   if (version > SCHEMA_VERSION) throw new NewerSchemaError(version);
   return version;
}

/**
 * 起動時に呼ぶ。保存先のデータが古ければ、変換前の全データを meta にバックアップしてから、
 * 現在の形に変換して保存し直す。変換に失敗してもバージョンは上げないので、次の起動でやり直される。
 * @param {Repository} repository
 * @returns {Promise<boolean>} 変換したら true
 */
export async function upgradeStorage(repository) {
   const recorded = await repository.getMeta('schemaVersion');
   // 初期データも入っていない保存先(初めて使う)は空なので、変換せずに現在のバージョンを記録するだけにする。
   // 変換(importAll)を通すと「初期データ投入済み」の印が付き、初期データが入らなくなるため
   const fresh = recorded == null && !(await repository.getMeta('seeded'));
   const version = fresh ? SCHEMA_VERSION : notNewer(recorded ?? UNTRACKED_VERSION);
   if (version < SCHEMA_VERSION) {
      // exportAll は現在のバージョンを名乗るので、保存先の実際のバージョンに付け替える
      const snapshot = { ...(await repository.exportAll()), schemaVersion: version };
      await repository.setMeta(`backup:v${version}:${snapshot.exportedAt}`, snapshot);
      await repository.importAll(snapshot);
   }
   if (recorded !== SCHEMA_VERSION) await repository.setMeta('schemaVersion', SCHEMA_VERSION);
   return version < SCHEMA_VERSION;
}

/**
 * エクスポートデータを検証し、現在の schemaVersion の形に揃える。
 * スキーマを変えたときは、ここに旧バージョンからの変換を足していく。
 * @param {string|object} json
 * @returns {ExportData}
 */
export function migrate(json) {
   let data;
   try {
      data = typeof json === 'string' ? JSON.parse(json) : json;
   } catch {
      throw new Error('JSONとして読み込めませんでした');
   }
   if (!data || typeof data !== 'object' || typeof data.schemaVersion !== 'number') {
      throw new Error('このアプリのエクスポートデータではありません');
   }
   if (data.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`新しいバージョンのデータです(schemaVersion ${data.schemaVersion})。アプリを更新してください`);
   }
   if (data.schemaVersion < OLDEST_READABLE_VERSION) {
      throw new Error(`古い形式のデータなので読み込めません(schemaVersion ${data.schemaVersion})`);
   }

   const result = { schemaVersion: SCHEMA_VERSION, exportedAt: data.exportedAt ?? new Date().toISOString() };
   // v4・v5 → v6: アレンジ(tracks / clips / markers)がないデータは、空として読み込む
   for (const name of COLLECTIONS) {
      const records = data[name] ?? [];
      if (!Array.isArray(records) || records.some((r) => !r || typeof r.id !== 'string')) {
         throw new Error(`データが壊れています: ${name}`);
      }
      result[name] = records;
   }
   // v4 → v5: タスクに開始日と終了日を足した。項目の有無が混ざると Supabase の一括保存が失敗するので、ここで揃える
   // v6 → v7: 連動タスクの clipId を足した。ふつうのタスクは null
   result.tasks = result.tasks.map((t) => ({ ...t, startDate: t.startDate ?? null, endDate: t.endDate ?? null, clipId: t.clipId ?? null }));
   // v6 → v7: 置いてあるクリップに連動タスクを作る(セクションに入っていないクリップには作らない)
   if (data.schemaVersion < 7) {
      for (const project of result.projects) {
         const of = (records) => records.filter((r) => r.projectId === project.id);
         if (!of(result.clips).length) continue;
         const { save } = syncClipTasks({
            lanes: of(result.lanes), tracks: of(result.tracks), clips: of(result.clips), markers: of(result.markers), tasks: of(result.tasks),
         });
         result.tasks.push(...save);
      }
   }
   // v7 → v8: MIDI の項目を足した。Supabase の一括保存のため、項目の有無が混ざらないように揃える
   // v8 → v9 → v10: スケールの並びを足した。v9 の scale は1小節目のスケールにする
   result.projects = result.projects.map((p) => {
      if (p.isTemplate) return p;
      const { scale, ...rest } = p;
      return { ...rest, bpm: projectBpm(p), scales: normalizeScales(p.scales ?? (scale ? [{ ...scale, bar: 1 }] : [])) };
   });
   result.tracks = result.tracks.map((t) => ({ ...t, ...trackSound(t) }));
   result.clips = result.clips.map((c) => ({ ...c, notes: normalizeNotes(c.notes) }));
   return result;
}
