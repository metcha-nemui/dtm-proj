// 文書ストア(DocumentStore)の Supabase 実装。Supabase の REST API(PostgREST)を fetch で直接呼ぶ。
// テーブル定義は supabase/schema.sql。接続には Project URL と公開キーだけを使う。
//
// レコードは項目の形を問わず、records テーブルの data 列(jsonb)にそのまま入れる。
// 列に出すのは、コレクション名・id・projectId(プロジェクト単位で読む・消すため)だけ。
// こうしておけば、アプリ側で項目を足したり変えたりしても、テーブルを作り直さなくてよい。

import { COLLECTIONS, createRepository } from './repository.js';

const RECORDS = 'records';
const META = 'app_meta';
const PAGE_SIZE = 1000; // API が1回に返す行数の上限(Supabase の既定値)。書き込みもこの単位で分ける
const IN_LIST_SIZE = 100; // id=in.(…) で並べる数。URL が長くなりすぎないように

/** アプリのレコード → テーブルの行。プロジェクトは自身の id を project_id に入れる */
export function toRow(collection, record) {
   return {
      collection,
      id: record.id,
      project_id: collection === 'projects' ? record.id : record.projectId,
      data: record,
   };
}

/** テーブルの行 → アプリのレコード */
export const fromRow = (row) => row.data;

// filter(1項目の一致)→ 絞り込みの条件。projectId と id は列で、それ以外は data の中の項目で絞る
function toCondition(filter = {}) {
   return Object.fromEntries(Object.entries(filter).map(([field, value]) => {
      const column = field === 'projectId' ? 'project_id' : field === 'id' ? 'id' : `data->>${field}`;
      return [column, `eq.${value}`];
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
         throw new Error('Supabase に接続できないため、読み込みも保存もできませんでした。Project URL とネットワークを確認してください');
      }
      if (!response.ok) throw await toError(response);
      return method === 'GET' ? response.json() : null;
   }

   // 条件に合う行をすべて読む。上限を超える分は、続きを取りに行く
   async function select(query, columns = '*') {
      const rows = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
         const page = await request('GET', RECORDS, {
            query: { select: columns, ...query, order: 'collection,id', limit: PAGE_SIZE, offset },
         });
         rows.push(...page);
         if (page.length < PAGE_SIZE) return rows;
      }
   }

   // あれば更新、なければ追加。1回のリクエストは1つのトランザクションになる
   async function upsert(rows) {
      for (let i = 0; i < rows.length; i += PAGE_SIZE) {
         await request('POST', RECORDS, {
            body: rows.slice(i, i + PAGE_SIZE),
            prefer: 'resolution=merge-duplicates,return=minimal',
         });
      }
   }

   const find = async (collection, filter) => (await select({ collection: `eq.${collection}`, ...toCondition(filter) }))
      .map(fromRow);

   return createRepository({
      find,
      get: async (collection, id) => (await find(collection, { id }))[0] ?? null,
      put: (collection, records) => upsert(records.map((r) => toRow(collection, r))),
      remove: (collection, filter) => request('DELETE', RECORDS, {
         query: { collection: `eq.${collection}`, ...toCondition(filter) },
      }),

      async getMeta(metaKey) {
         const rows = await request('GET', META, { query: { select: 'value', key: `eq.${metaKey}` } });
         return rows[0]?.value;
      },
      setMeta: (metaKey, value) => request('POST', META, {
         body: [{ key: metaKey, value }],
         prefer: 'resolution=merge-duplicates,return=minimal',
      }),

      // 先に新しい中身を上書きで入れ、そのあとで新しい中身にない行を消す。
      // 全体は1つのトランザクションではないが、途中で失敗しても行が消えすぎることはない(余分な行が残るだけ)。
      // その場合は、同じ操作をもう一度行えば揃う。
      async replaceAll(data) {
         const before = await select({}, 'collection,id');
         const rows = COLLECTIONS.flatMap((name) => data[name].map((r) => toRow(name, r)));
         await upsert(rows);
         const keep = new Set(rows.map((r) => `${r.collection}/${r.id}`));
         const stale = Map.groupBy(before.filter((r) => !keep.has(`${r.collection}/${r.id}`)), (r) => r.collection);
         for (const [collection, list] of stale) {
            for (let i = 0; i < list.length; i += IN_LIST_SIZE) {
               const ids = list.slice(i, i + IN_LIST_SIZE).map((r) => `"${r.id}"`).join(',');
               await request('DELETE', RECORDS, { query: { collection: `eq.${collection}`, id: `in.(${ids})` } });
            }
         }
      },
   });
}

/** ログイン時の確認。接続先・公開キー・テーブルのどれかに問題があれば、理由つきで失敗する。 */
export async function checkConnection(config, fetchImpl) {
   const repository = createSupabaseRepository(config, fetchImpl);
   // 2つのテーブルの両方に届くことを確かめる
   await Promise.all([repository.getMeta('seeded'), repository.getTemplates()]);
}
