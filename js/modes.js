// 保存先のモード(オンライン = Supabase / オフライン = このブラウザの IndexedDB)ごとの repository。
// 一覧のタブで行き来するので、モードごとに1つ作って使い回す。スキーマの確認と変換(upgradeStorage)は最初の1回だけ。

import { loadSession } from './session.js';
import { createIndexedDbRepository } from './store/indexeddb.js';
import { upgradeStorage } from './store/repository.js';
import { createSupabaseRepository } from './store/supabase.js';

export const MODES = {
   online: { label: 'オンライン', icon: 'cloud', title: 'Supabase に保存しているプロジェクト' },
   offline: { label: 'オフライン', icon: 'hard-drive', title: 'このブラウザ(IndexedDB)に保存しているプロジェクト' },
};

/** @param {'online'|'offline'} mode @returns {'online'|'offline'} */
export function otherMode(mode) {
   return mode === 'online' ? 'offline' : 'online';
}

/** オンラインを開こうとしたが、Supabase の接続情報がない(ログインしていない)。 */
export class NotLoggedInError extends Error {
   constructor() {
      super('Supabase にログインしていません');
      this.name = 'NotLoggedInError';
   }
}

/** @returns {boolean} オンラインを使えるか(接続情報があるか。届くかどうかは見ない) */
export function canUseOnline() {
   return loadSession() != null;
}

const cache = new Map();

/**
 * そのモードの repository。初めて使うときに、保存先のデータを現在の形に揃える。
 * 届かない・データが新しすぎる(NewerSchemaError)などで失敗したら、次に呼んだときにやり直す。
 * @param {'online'|'offline'} mode
 * @returns {Promise<import('./store/repository.js').Repository>}
 */
export function repositoryFor(mode) {
   let promise = cache.get(mode);
   if (!promise) {
      promise = (async () => {
         let repository;
         if (mode === 'online') {
            const session = loadSession();
            if (!session) throw new NotLoggedInError();
            repository = createSupabaseRepository(session);
         } else {
            repository = createIndexedDbRepository();
         }
         await upgradeStorage(repository);
         return repository;
      })();
      cache.set(mode, promise);
      promise.catch(() => { if (cache.get(mode) === promise) cache.delete(mode); });
   }
   return promise;
}

/** 次に使うときに作り直させる(ログイン・ログアウトしたとき、データが新しくなっていたとき)。 */
export function forgetRepository(mode) {
   cache.delete(mode);
}
