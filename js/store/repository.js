// repository のインターフェース定義。
// UIとドメインロジックはここで定義したメソッドだけを使う。実装は indexeddb.js(将来は Supabase)。
// すべて非同期(Promise)で、実装を差し替えてもシグネチャは変えない。

// v3: セクション種別と定番タスクを、テンプレートの中に持つようにした。
// それより前のデータは形が違い、変換を用意していないので読み込めない。
export const SCHEMA_VERSION = 3;
const OLDEST_READABLE_VERSION = 3;

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} title
 * @property {string} memo
 * @property {string|null} dueDate 締切(YYYY-MM-DD)。なければ null
 * @property {string|null} templateId 作成元のテンプレート。セクション追加の選択肢と、定番の追加先に使う。なければ null
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
 * セクション種別。テンプレートごとに持つ(他のテンプレートとは共有しない)。
 * @typedef {Object} SectionKind
 * @property {string} id
 * @property {string} templateId
 * @property {string} name
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} TemplateTask
 * @property {string} id
 * @property {string} templateId
 * @property {'kind'|'global'} scope 種別の定番か、「全体」の定番か
 * @property {string|null} kindId scope='kind' のとき
 * @property {string} title
 * @property {string} memo
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * プロジェクトのテンプレート。種別(SectionKind)と定番タスク(TemplateTask)は templateId でここに属する。
 * @typedef {Object} Template
 * @property {string} id
 * @property {string} name
 * @property {string[]} sections このテンプレートの kindId を並び順どおりに。「全体」レーンは含めない(常に作られる)
 * @property {number} order
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Library
 * @property {Template[]} templates
 * @property {SectionKind[]} kinds
 * @property {TemplateTask[]} templateTasks
 */

/**
 * @typedef {Object} ExportData
 * @property {number} schemaVersion
 * @property {string} exportedAt
 * @property {Project[]} projects
 * @property {Lane[]} lanes
 * @property {Task[]} tasks
 * @property {Template[]} templates
 * @property {SectionKind[]} kinds
 * @property {TemplateTask[]} templateTasks
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
 * @property {(t: Template) => Promise<void>} saveTemplate
 * @property {(ts: Template[]) => Promise<void>} saveTemplates
 * @property {(id: string) => Promise<void>} deleteTemplate 種別と定番タスクも一緒に消す
 * @property {(k: SectionKind) => Promise<void>} saveKind
 * @property {(ks: SectionKind[]) => Promise<void>} saveKinds
 * @property {(id: string) => Promise<void>} deleteKind
 * @property {(t: TemplateTask) => Promise<void>} saveTemplateTask
 * @property {(ts: TemplateTask[]) => Promise<void>} saveTemplateTasks
 * @property {(id: string) => Promise<void>} deleteTemplateTask
 *
 * @property {(key: string) => Promise<any>} getMeta アプリ内部の状態(シード済みフラグなど)
 * @property {(key: string, value: any) => Promise<void>} setMeta
 *
 * @property {() => Promise<ExportData>} exportAll
 * @property {(json: string|object) => Promise<void>} importAll 既存データをすべて置き換える
 */

export const COLLECTIONS = ['projects', 'lanes', 'tasks', 'templates', 'kinds', 'templateTasks'];

const METHODS = [
   'getProjects', 'getProject', 'saveProject', 'deleteProject',
   'getLanes', 'saveLane', 'saveLanes', 'deleteLane',
   'getTasks', 'saveTask', 'saveTasks', 'deleteTask',
   'getLibrary',
   'saveTemplate', 'saveTemplates', 'deleteTemplate',
   'saveKind', 'saveKinds', 'deleteKind',
   'saveTemplateTask', 'saveTemplateTasks', 'deleteTemplateTask',
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
   if (data.schemaVersion < OLDEST_READABLE_VERSION) {
      throw new Error(`古い形式のデータなので読み込めません(schemaVersion ${data.schemaVersion})`);
   }

   const result = { schemaVersion: SCHEMA_VERSION, exportedAt: data.exportedAt ?? new Date().toISOString() };
   for (const name of COLLECTIONS) {
      const records = data[name] ?? [];
      if (!Array.isArray(records) || records.some((r) => !r || typeof r.id !== 'string')) {
         throw new Error(`データが壊れています: ${name}`);
      }
      result[name] = records;
   }
   return result;
}
