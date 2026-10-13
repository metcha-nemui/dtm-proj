// repository のインターフェース定義。
// UIとドメインロジックはここで定義したメソッドだけを使う。実装は indexeddb.js と supabase.js。
// すべて非同期(Promise)で、実装を差し替えてもシグネチャは変えない。

// v4: テンプレートをプロジェクトと同じ形(isTemplate の付いたプロジェクト)で持つようにし、
// セクション種別と定番タスクをやめた。それより前のデータは形が違い、変換を用意していないので読み込めない。
// v5: タスクに開始日と終了日(startDate / endDate)を足した。v4 のデータは、日付なしとして読み込む。
export const SCHEMA_VERSION = 5;
const OLDEST_READABLE_VERSION = 4;

/**
 * プロジェクトも、テンプレートも Project として扱う。テンプレートは「ステータスを使わないプロジェクト」で、
 * レーンとタスクの持ち方は同じ。プロジェクトは、どのテンプレートから作ったかを覚えない。
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} title テンプレートでは、テンプレートの名前
 * @property {string} memo
 * @property {string|null} dueDate 締切(YYYY-MM-DD)。なければ null。テンプレートでは使わない
 * @property {boolean} isTemplate
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
 * @property {string} laneId
 * @property {string} title
 * @property {string} memo
 * @property {'todo'|'doing'|'done'} status テンプレートでは使わない(常に 'todo')
 * @property {number} order
 * @property {string|null} doneAt
 * @property {string|null} startDate 開始日(YYYY-MM-DD)。なければ null。テンプレートでは使わない(常に null)
 * @property {string|null} endDate 終了日(YYYY-MM-DD)。なければ null。テンプレートでは使わない(常に null)
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
 */

/**
 * @typedef {Object} Repository
 * @property {() => Promise<Project[]>} getProjects テンプレートは含めない
 * @property {() => Promise<Project[]>} getTemplates テンプレートだけ
 * @property {(id: string) => Promise<Project|null>} getProject プロジェクトでもテンプレートでも
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
 * @property {(key: string) => Promise<any>} getMeta アプリ内部の状態(シード済みフラグなど)
 * @property {(key: string, value: any) => Promise<void>} setMeta
 *
 * @property {() => Promise<ExportData>} exportAll
 * @property {(json: string|object) => Promise<void>} importAll 既存データをすべて置き換える
 */

export const COLLECTIONS = ['projects', 'lanes', 'tasks'];

const METHODS = [
   'getProjects', 'getTemplates', 'getProject', 'saveProject', 'deleteProject',
   'getLanes', 'saveLane', 'saveLanes', 'deleteLane',
   'getTasks', 'saveTask', 'saveTasks', 'deleteTask',
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
   // v4 → v5: タスクに開始日と終了日を足した。項目の有無が混ざると Supabase の一括保存が失敗するので、ここで揃える
   result.tasks = result.tasks.map((t) => ({ ...t, startDate: t.startDate ?? null, endDate: t.endDate ?? null }));
   return result;
}
