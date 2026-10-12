// repository のインターフェース定義。
// UIとドメインロジックはここで定義したメソッドだけを使う。実装は indexeddb.js(将来は Supabase)。
// すべて非同期(Promise)で、実装を差し替えてもシグネチャは変えない。

export const SCHEMA_VERSION = 2;

// 廃止した項目。古いエクスポートデータを読むときに落とす(Supabase では、テーブルにない列を送ると失敗する)。
// v2: タスクの出自(定番 / 固有)と、セクション種別の色をやめた
const DROPPED_FIELDS = { tasks: ['origin', 'sourceTemplateTaskId'], kinds: ['color'] };

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} title
 * @property {string} memo
 * @property {string|null} dueDate 締切(YYYY-MM-DD)。なければ null
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
 * @property {string|null} kindId 由来するセクション種別。global なら null
 * @property {number} order
 * @property {boolean} collapsed
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} projectId
 * @property {string} laneId
 * @property {string} title
 * @property {string} memo
 * @property {'todo'|'doing'|'done'} status
 * @property {number} order
 * @property {string|null} doneAt
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} SectionKind
 * @property {string} id
 * @property {string} name
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} TemplateTask
 * @property {string} id
 * @property {'kind'|'global'} scope
 * @property {string|null} kindId scope='kind' のとき
 * @property {string} title
 * @property {string} memo
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} StructureTemplate
 * @property {string} id
 * @property {string} name
 * @property {string[]} sections kindId を並び順どおりに。「全体」レーンは含めない(常に作られる)
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Library
 * @property {SectionKind[]} kinds
 * @property {TemplateTask[]} templateTasks
 * @property {StructureTemplate[]} structures
 */

/**
 * @typedef {Object} ExportData
 * @property {number} schemaVersion
 * @property {string} exportedAt
 * @property {Project[]} projects
 * @property {Lane[]} lanes
 * @property {Task[]} tasks
 * @property {SectionKind[]} kinds
 * @property {TemplateTask[]} templateTasks
 * @property {StructureTemplate[]} structures
 */

/**
 * @typedef {Object} Repository
 * @property {() => Promise<Project[]>} getProjects
 * @property {(id: string) => Promise<Project|null>} getProject
 * @property {(p: Project) => Promise<void>} saveProject
 * @property {(id: string) => Promise<void>} deleteProject レーンとタスクも一緒に消す
 *
 * @property {(projectId: string) => Promise<Lane[]>} getLanes
 * @property {(l: Lane) => Promise<void>} saveLane
 * @property {(ls: Lane[]) => Promise<void>} saveLanes
 * @property {(id: string) => Promise<void>} deleteLane レーン内のタスクも一緒に消す
 *
 * @property {(projectId: string) => Promise<Task[]>} getTasks
 * @property {(t: Task) => Promise<void>} saveTask
 * @property {(ts: Task[]) => Promise<void>} saveTasks
 * @property {(id: string) => Promise<void>} deleteTask
 *
 * @property {() => Promise<Library>} getLibrary
 * @property {(k: SectionKind) => Promise<void>} saveKind
 * @property {(ks: SectionKind[]) => Promise<void>} saveKinds
 * @property {(id: string) => Promise<void>} deleteKind
 * @property {(t: TemplateTask) => Promise<void>} saveTemplateTask
 * @property {(ts: TemplateTask[]) => Promise<void>} saveTemplateTasks
 * @property {(id: string) => Promise<void>} deleteTemplateTask
 * @property {(s: StructureTemplate) => Promise<void>} saveStructure
 * @property {(ss: StructureTemplate[]) => Promise<void>} saveStructures
 * @property {(id: string) => Promise<void>} deleteStructure
 *
 * @property {(key: string) => Promise<any>} getMeta アプリ内部の状態(シード済みフラグなど)
 * @property {(key: string, value: any) => Promise<void>} setMeta
 *
 * @property {() => Promise<ExportData>} exportAll
 * @property {(json: string|object) => Promise<void>} importAll 既存データをすべて置き換える
 */

export const COLLECTIONS = ['projects', 'lanes', 'tasks', 'kinds', 'templateTasks', 'structures'];

const METHODS = [
   'getProjects', 'getProject', 'saveProject', 'deleteProject',
   'getLanes', 'saveLane', 'saveLanes', 'deleteLane',
   'getTasks', 'saveTask', 'saveTasks', 'deleteTask',
   'getLibrary',
   'saveKind', 'saveKinds', 'deleteKind',
   'saveTemplateTask', 'saveTemplateTasks', 'deleteTemplateTask',
   'saveStructure', 'saveStructures', 'deleteStructure',
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

   const result = { schemaVersion: SCHEMA_VERSION, exportedAt: data.exportedAt ?? new Date().toISOString() };
   for (const name of COLLECTIONS) {
      const records = data[name] ?? [];
      if (!Array.isArray(records) || records.some((r) => !r || typeof r.id !== 'string')) {
         throw new Error(`データが壊れています: ${name}`);
      }
      const dropped = DROPPED_FIELDS[name] ?? [];
      result[name] = records.map((record) =>
         Object.fromEntries(Object.entries(record).filter(([field]) => !dropped.includes(field))));
   }
   return result;
}
