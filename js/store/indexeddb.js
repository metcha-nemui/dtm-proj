// 文書ストア(DocumentStore)の IndexedDB 実装。ログインせずに使うときの保存先。
// コレクションごとにオブジェクトストアを持ち、絞り込みに使う項目(projectId, laneId, trackId)にインデックスを張っている。

import { COLLECTIONS, createRepository } from './repository.js';

const DB_NAME = 'dtm-proj';
const DB_VERSION = 4;
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
               // ここで作るのは v3 の時点のストアだけ。後から足したものは、下の分岐で作る
               for (const name of ['projects', 'lanes', 'tasks']) db.createObjectStore(name, { keyPath: 'id' });
               db.createObjectStore(META, { keyPath: 'key' });
               const { transaction } = req;
               transaction.objectStore('lanes').createIndex('projectId', 'projectId');
               transaction.objectStore('tasks').createIndex('projectId', 'projectId');
               transaction.objectStore('tasks').createIndex('laneId', 'laneId');
            }
            if (event.oldVersion < 4) {
               // v4 でアレンジ(トラック・クリップ・マーカー)を足した。既存のデータには触らない
               const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
               tracks.createIndex('projectId', 'projectId');
               const clips = db.createObjectStore('clips', { keyPath: 'id' });
               clips.createIndex('projectId', 'projectId');
               clips.createIndex('trackId', 'trackId');
               const markers = db.createObjectStore('markers', { keyPath: 'id' });
               markers.createIndex('projectId', 'projectId');
               markers.createIndex('laneId', 'laneId');
            }
         };
         req.onsuccess = () => resolve(req.result);
         req.onerror = () => reject(req.error);
         req.onblocked = () => reject(new Error('別のタブがデータベースを使用中です。他のタブを閉じてください'));
      });
      return dbPromise;
   }

   // filter は1項目の一致。id は主キーで、それ以外は同じ名前のインデックスで引く
   async function getAll(name, filter) {
      const db = await open();
      const store = db.transaction(name).objectStore(name);
      if (!filter) return request(store.getAll());
      const [[field, value]] = Object.entries(filter);
      return request(field === 'id' ? store.getAll(value) : store.index(field).getAll(value));
   }

   async function write(names, fn) {
      const db = await open();
      const tx = db.transaction(names, 'readwrite');
      fn(tx);
      await completed(tx);
   }

   return createRepository({
      find: getAll,
      async get(name, id) {
         const db = await open();
         return (await request(db.transaction(name).objectStore(name).get(id))) ?? null;
      },
      async put(name, records) {
         if (!records.length) return;
         await write(name, (tx) => {
            const store = tx.objectStore(name);
            for (const record of records) store.put(record);
         });
      },
      remove: (name, filter) => write(name, (tx) => {
         const store = tx.objectStore(name);
         const [[field, value]] = Object.entries(filter);
         if (field === 'id') store.delete(value);
         else deleteByIndex(store, field, value);
      }),

      async getMeta(key) {
         const db = await open();
         return (await request(db.transaction(META).objectStore(META).get(key)))?.value;
      },
      setMeta: (key, value) => write(META, (tx) => tx.objectStore(META).put({ key, value })),

      replaceAll: (data) => write(COLLECTIONS, (tx) => {
         for (const name of COLLECTIONS) {
            const store = tx.objectStore(name);
            store.clear();
            for (const record of data[name]) store.put(record);
         }
      }),
   });
}
