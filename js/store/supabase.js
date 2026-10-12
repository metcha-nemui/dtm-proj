// repository の Supabase 実装。Supabase の REST API(PostgREST)を fetch で直接呼ぶ。
// テーブル定義は supabase/schema.sql。接続には Project URL と公開キーだけを使う。

import { COLLECTIONS, SCHEMA_VERSION, assertRepository, migrate } from './repository.js';

// アプリ側のコレクション名 → テーブル名
const TABLES = {
   projects: 'projects',
   lanes: 'lanes',
   tasks: 'tasks',
   kinds: 'section_kinds',
   templateTasks: 'template_tasks',
   structures: 'structure_templates',
};
const META = 'app_meta';

// 外部キーの向きに合わせた順番。入れるときは親から、消すときは子から。
const INSERT_ORDER = ['projects', 'lanes', 'tasks', 'kinds', 'templateTasks', 'structures'];
const PAGE_SIZE = 1000; // API が1回に返す行数の上限(Supabase の既定値)
const TIMESTAMPS = new Set(['createdAt', 'updatedAt', 'doneAt']);

// 列名は snake_case。アプリの order だけは予約語を避けて sort_order にしてある。
const toColumn = (field) => (field === 'order' ? 'sort_order' : field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
const toField = (column) => (column === 'sort_order' ? 'order' : column.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));

/** アプリのレコード → テーブルの行 */
export function toRow(record) {
   return Object.fromEntries(Object.entries(record).map(([field, value]) => [toColumn(field), value]));
}

/** テーブルの行 → アプリのレコード。日時は IndexedDB 実装と同じ形(…Z)に揃える。 */
export function fromRow(row) {
   return Object.fromEntries(Object.entries(row).map(([column, value]) => {
      const field = toField(column);
      return [field, value && TIMESTAMPS.has(field) ? new Date(value).toISOString() : value];
   }));
}

async function toError(response) {
   const body = await response.json().catch(() => ({}));
   if (body.code === '42501') {
      return new Error('テーブルにアクセスする権限がありません。supabase/schema.sql を SQL Editor で実行してください');
   }
   if (body.code === 'PGRST205') {
      return new Error('テーブルが見つかりません。supabase/schema.sql を SQL Editor で実行してください');
   }
   if (response.status === 401) return new Error('Project URL か公開キーが正しくありません');
   return new Error(`Supabase でエラーが発生しました: ${body.message ?? response.status}`);
}

/**
 * @param {{ url: string, key: string }} config Project URL(https://xxxx.supabase.co)と公開キー
 * @param {typeof fetch} [fetchImpl] テスト用の差し替え
 * @returns {import('./repository.js').Repository}
 */
export function createSupabaseRepository({ url, key }, fetchImpl = (...args) => fetch(...args)) {
   const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

   async function request(method, table, { query = {}, body, prefer } = {}) {
      let response;
      try {
         response = await fetchImpl(`${url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
            method,
            headers: prefer ? { ...headers, Prefer: prefer } : headers,
            body: body && JSON.stringify(body),
         });
      } catch {
         throw new Error('Supabase に接続できません。Project URL とネットワークを確認してください');
      }
      if (!response.ok) throw await toError(response);
      return method === 'GET' ? response.json() : null;
   }

   // 条件に合う行をすべて読む。上限を超える分は、続きを取りに行く
   async function select(name, filters = {}) {
      const rows = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
         const page = await request('GET', TABLES[name], {
            query: { select: '*', ...filters, order: 'id', limit: PAGE_SIZE, offset },
         });
         rows.push(...page);
         if (page.length < PAGE_SIZE) return rows.map(fromRow);
      }
   }

   // あれば更新、なければ追加
   async function upsert(name, records) {
      for (let i = 0; i < records.length; i += PAGE_SIZE) {
         await request('POST', TABLES[name], {
            body: records.slice(i, i + PAGE_SIZE).map(toRow),
            prefer: 'resolution=merge-duplicates,return=minimal',
         });
      }
   }

   const remove = (name, id) => request('DELETE', TABLES[name], { query: { id: `eq.${id}` } });

   const setMeta = (metaKey, value) => request('POST', META, {
      body: [{ key: metaKey, value }],
      prefer: 'resolution=merge-duplicates,return=minimal',
   });

   return assertRepository({
      getProjects: () => select('projects'),
      getProject: async (id) => (await select('projects', { id: `eq.${id}` }))[0] ?? null,
      saveProject: (p) => upsert('projects', [p]),
      // レーンとタスクは、外部キーの on delete cascade で一緒に消える
      deleteProject: (id) => remove('projects', id),

      getLanes: (projectId) => select('lanes', { project_id: `eq.${projectId}` }),
      saveLane: (l) => upsert('lanes', [l]),
      saveLanes: (ls) => upsert('lanes', ls),
      // タスクは cascade で一緒に消える
      deleteLane: (id) => remove('lanes', id),

      getTasks: (projectId) => select('tasks', { project_id: `eq.${projectId}` }),
      saveTask: (t) => upsert('tasks', [t]),
      saveTasks: (ts) => upsert('tasks', ts),
      deleteTask: (id) => remove('tasks', id),

      async getLibrary() {
         const [kinds, templateTasks, structures] = await Promise.all([
            select('kinds'), select('templateTasks'), select('structures'),
         ]);
         return { kinds, templateTasks, structures };
      },
      saveKind: (k) => upsert('kinds', [k]),
      saveKinds: (ks) => upsert('kinds', ks),
      deleteKind: (id) => remove('kinds', id),
      saveTemplateTask: (t) => upsert('templateTasks', [t]),
      saveTemplateTasks: (ts) => upsert('templateTasks', ts),
      deleteTemplateTask: (id) => remove('templateTasks', id),
      saveStructure: (s) => upsert('structures', [s]),
      saveStructures: (ss) => upsert('structures', ss),
      deleteStructure: (id) => remove('structures', id),

      async getMeta(metaKey) {
         const rows = await request('GET', META, { query: { select: 'value', key: `eq.${metaKey}` } });
         return rows[0]?.value;
      },
      setMeta,

      async exportAll() {
         const lists = await Promise.all(COLLECTIONS.map((name) => select(name)));
         const data = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
         COLLECTIONS.forEach((name, i) => { data[name] = lists[i]; });
         return data;
      },

      // 全部消してから入れ直す。1つのトランザクションではないので、途中で失敗すると中途半端な状態が残る。
      // その場合は、同じファイルをもう一度インポートすれば揃う。
      async importAll(json) {
         const data = migrate(json);
         for (const name of [...INSERT_ORDER].reverse()) {
            await request('DELETE', TABLES[name], { query: { id: 'not.is.null' } });
         }
         for (const name of INSERT_ORDER) await upsert(name, data[name]);
         // インポート後に初期データを重ねて投入しないようにする
         await setMeta('seeded', true);
      },
   });
}

/** ログイン時の確認。接続先・公開キー・テーブルのどれかに問題があれば、理由つきで失敗する。 */
export async function checkConnection(config, fetchImpl) {
   await createSupabaseRepository(config, fetchImpl).getMeta('seeded');
}
