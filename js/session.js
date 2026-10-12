// 擬似ログインの状態。保存先の選択と、Supabase の接続先(Project URL と公開キー)を
// このブラウザの localStorage に覚えておく。Supabase Auth によるユーザー認証はしていない。

const STORAGE_KEY = 'dtm-proj:session';

/**
 * @typedef {{ mode: 'supabase', url: string, key: string } | { mode: 'local' }} Session
 * 'supabase' は Supabase に保存、'local' はログインせずこのブラウザ(IndexedDB)にだけ保存。
 */

/** @returns {Session|null} 未ログインなら null */
export function loadSession() {
   try {
      const session = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (session?.mode === 'local') return { mode: 'local' };
      if (session?.mode === 'supabase' && session.url && session.key) return session;
   } catch {
      // 壊れた値や、localStorage を使えない環境では未ログインとして扱う
   }
   return null;
}

/** @param {Session} session */
export function saveSession(session) {
   localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
   localStorage.removeItem(STORAGE_KEY);
}

/** 入力された Project URL を、末尾のパスなどを除いた形(https://xxxx.supabase.co)に揃える。 */
export function normalizeProjectUrl(input) {
   let url;
   try {
      url = new URL(input.trim());
   } catch {
      throw new Error('Project URL の形式が正しくありません(例: https://xxxx.supabase.co)');
   }
   if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      throw new Error('Project URL は https:// で始まる必要があります');
   }
   return url.origin;
}
