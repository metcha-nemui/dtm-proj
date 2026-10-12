// repository の IndexedDB 実装(MVP)。

import { COLLECTIONS, SCHEMA_VERSION, assertRepository, migrate } from './repository.js';

const DB_NAME = 'dtm-proj';
const DB_VERSION = 3;
const META = 'meta';

function request(req) {
   return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
   });
}

function completed(tx) {
   return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('トランザクションが中断されました'));
   });
}

// インデックスに一致するレコードを、同じトランザクションの中で消す。
function deleteByIndex(store, indexName, key) {
   const req = store.index(indexName).openKeyCursor(IDBKeyRange.only(key));
   req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
   };
}

/** @returns {import('./repository.js').Repository} */
export function createIndexedDbRepository(dbName = DB_NAME) {
   let dbPromise = null;

   function open() {
      dbPromise ??= new Promise((resolve, reject) => {
         const req = indexedDB.open(dbName, DB_VERSION);
         req.onupgradeneeded = (event) => {
            const db = req.result;
            if (event.oldVersion < 3) {
               // v3 でテンプレートの形を変えた(プロジェクトと同じ形で持ち、種別と定番タスクをやめた)。
               // 以前のデータは変換せずに捨て、空の状態から作り直す(初期データが入り直す)。
               for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
               for (const name of COLLECTIONS) db.createObjectStore(name, { keyPath: 'id' });
               db.createObjectStore(META, { keyPath: 'key' });
               const { transaction } = req;
               transaction.objectStore('lanes').createIndex('projectId', 'projectId');
               transaction.objectStore('tasks').createIndex('projectId', 'projectId');
               transaction.objectStore('tasks').createIndex('laneId', 'laneId');
            }
         };
         req.onsuccess = () => resolve(req.result);
         req.onerror = () => reject(req.error);
         req.onblocked = () => reject(new Error('別のタブがデータベースを使用中です。他のタブを閉じてください'));
      });
      return dbPromise;
   }

   async function getAll(storeName, indexName, key) {
      const db = await open();
      const store = db.transaction(storeName).objectStore(storeName);
      return request(indexName ? store.index(indexName).getAll(key) : store.getAll());
   }

   async function getOne(storeName, id) {
      const db = await open();
      return (await request(db.transaction(storeName).objectStore(storeName).get(id))) ?? null;
   }

   async function putAll(storeName, records) {
      if (!records.length) return;
      const db = await open();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const record of records) store.put(record);
      await completed(tx);
   }

   async function remove(storeName, id) {
      const db = await open();
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      await completed(tx);
   }

   return assertRepository({
      // プロジェクトとテンプレートは同じストアに入っている(件数が少ないので、読んでから振り分ける)
      getProjects: async () => (await getAll('projects')).filter((p) => !p.isTemplate),
      getTemplates: async () => (await getAll('projects')).filter((p) => p.isTemplate),
      getProject: (id) => getOne('projects', id),
      saveProject: (p) => putAll('projects', [p]),
      async deleteProject(id) {
         const db = await open();
         const tx = db.transaction(['projects', 'lanes', 'tasks'], 'readwrite');
         tx.objectStore('projects').delete(id);
         deleteByIndex(tx.objectStore('lanes'), 'projectId', id);
         deleteByIndex(tx.objectStore('tasks'), 'projectId', id);
         await completed(tx);
      },

      getLanes: (projectId) => getAll('lanes', 'projectId', projectId),
      saveLane: (l) => putAll('lanes', [l]),
      saveLanes: (ls) => putAll('lanes', ls),
      async deleteLane(id) {
         const db = await open();
         const tx = db.transaction(['lanes', 'tasks'], 'readwrite');
         tx.objectStore('lanes').delete(id);
         deleteByIndex(tx.objectStore('tasks'), 'laneId', id);
         await completed(tx);
      },

      getTasks: (projectId) => getAll('tasks', 'projectId', projectId),
      saveTask: (t) => putAll('tasks', [t]),
      saveTasks: (ts) => putAll('tasks', ts),
      deleteTask: (id) => remove('tasks', id),

      async getMeta(key) {
         return (await getOne(META, key))?.value;
      },
      setMeta: (key, value) => putAll(META, [{ key, value }]),

      async exportAll() {
         const db = await open();
         const tx = db.transaction(COLLECTIONS);
         const lists = await Promise.all(COLLECTIONS.map((name) => request(tx.objectStore(name).getAll())));
         const data = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
         COLLECTIONS.forEach((name, i) => { data[name] = lists[i]; });
         return data;
      },

      async importAll(json) {
         const data = migrate(json);
         const db = await open();
         const tx = db.transaction([...COLLECTIONS, META], 'readwrite');
         for (const name of COLLECTIONS) {
            const store = tx.objectStore(name);
            store.clear();
            for (const record of data[name]) store.put(record);
         }
         // インポート後に初期データを重ねて投入しないようにする
         tx.objectStore(META).put({ key: 'seeded', value: true });
         await completed(tx);
      },
   });
}
