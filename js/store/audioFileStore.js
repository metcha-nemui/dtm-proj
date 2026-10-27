// オーディオトラックの音声ファイルを、このブラウザに保存しておく。音源(soundFontStore.js)と同じく端末ごとのもので、
// プロジェクトのデータ(repository。Supabase にもなる)とは別の IndexedDB に入れ、エクスポートにも含めない。
// Track の audio.fileId をキーにする。別の端末では同じ fileId の中身がないので、画面で選び直してもらう。
// 波形の表示に使う値(peaks)も一緒に持つ(開くたびに音声を読み直さないため)。

const DB_NAME = 'dtm-proj-audio';
const STORE = 'files';

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

/**
 * @typedef {Object} AudioFileRecord
 * @property {string} projectId 使っているプロジェクト(使われなくなったものを消すときに、プロジェクトごとに見る)
 * @property {string} name
 * @property {number} size
 * @property {string} savedAt
 * @property {Blob} blob
 * @property {Uint8Array} peaks domain/audio.js の audioPeaks
 */

/** @returns {Promise<AudioFileRecord|null>} */
export async function loadAudioFile(fileId) {
   return (await transact('readonly', (store) => store.get(fileId))) ?? null;
}

/** 保存しているファイルの id。 @returns {Promise<Set<string>>} */
export async function audioFileIds() {
   return new Set(await transact('readonly', (store) => store.getAllKeys()));
}

/** @param {{ projectId: string, file: File, peaks: Uint8Array }} input */
export async function saveAudioFile(fileId, { projectId, file, peaks }) {
   const record = { projectId, name: file.name, size: file.size, savedAt: new Date().toISOString(), blob: file, peaks };
   await transact('readwrite', (store) => store.put(record, fileId));
   // 容量が足りなくなったときに、ブラウザが勝手に消さないよう頼んでおく(断られても、消されたら選び直せばよい)
   navigator.storage?.persist?.().catch(() => {});
}

/**
 * ファイルを別の id へ写す(プロジェクトの複製)。このブラウザに中身がないものは飛ばす。
 * @param {string} projectId 写した先を使うプロジェクト
 * @param {{ from: string, to: string }[]} pairs
 * @returns {Promise<number>} 写した数
 */
export async function copyAudioFiles(projectId, pairs) {
   let copied = 0;
   for (const { from, to } of pairs) {
      const stored = await loadAudioFile(from);
      if (!stored) continue;
      await transact('readwrite', (store) => store.put({ ...stored, projectId, savedAt: new Date().toISOString() }, to));
      copied++;
   }
   return copied;
}

/**
 * プロジェクトのファイルのうち、keep にないものを消す。keep を渡さなければ、そのプロジェクトのものをすべて消す。
 * @returns {Promise<number>} 消した数
 */
export async function removeAudioFiles(projectId, keep = new Set()) {
   let removed = 0;
   await transact('readwrite', (store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
         const cursor = request.result;
         if (!cursor) return;
         if (cursor.value.projectId === projectId && !keep.has(cursor.key)) {
            cursor.delete();
            removed++;
         }
         cursor.continue();
      };
      return null;
   });
   return removed;
}
