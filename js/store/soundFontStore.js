// 再生に使う音源ファイル(SoundFont の .sf2 / .sf3、DLS の .dls)を、このブラウザに保存しておく。
// 端末ごとの設定なので、プロジェクトのデータ(repository。Supabase にもなる)とは別の IndexedDB に入れ、
// エクスポートにも含めない。数十MBになるので localStorage には入らない。ファイル(Blob)のまま持つ。

const DB_NAME = 'dtm-proj-soundfont';
const STORE = 'files';
const KEY = 'main';

function open() {
   return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
   });
}

async function transact(mode, work) {
   const db = await open();
   try {
      return await new Promise((resolve, reject) => {
         const tx = db.transaction(STORE, mode);
         const request = work(tx.objectStore(STORE));
         tx.oncomplete = () => resolve(request?.result);
         tx.onerror = () => reject(tx.error);
         tx.onabort = () => reject(tx.error);
      });
   } finally {
      db.close();
   }
}

/** @returns {Promise<{ name: string, size: number, savedAt: string, blob: Blob }|null>} */
export async function loadSoundFont() {
   return (await transact('readonly', (store) => store.get(KEY))) ?? null;
}

/** @param {File} file */
export async function saveSoundFont(file) {
   const record = { name: file.name, size: file.size, savedAt: new Date().toISOString(), blob: file };
   await transact('readwrite', (store) => store.put(record, KEY));
   return record;
}

export async function removeSoundFont() {
   await transact('readwrite', (store) => store.delete(KEY));
}
