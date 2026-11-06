// 擬似ログインの状態。Supabase の接続先(Project URL と公開キー)を、このブラウザの localStorage に覚えておく。
// Supabase Auth によるユーザー認証はしていない。オフライン(IndexedDB)のタブにいる間も消さない。

const STORAGE_KEY = 'dtm-proj:session';

/**
 * @typedef {{ url: string, key: string }} Session
 */

/** @returns {Session|null} ログインしていなければ null */
export function loadSession() {
   try {
      const session = JSON.parse(localStorage.getItem(STORAGE_KEY));
      // 保存先を1つに決めていたときの形({ mode: 'supabase', url, key } / { mode: 'local' })も、url と key だけを見て読む
      if (session?.url && session.key) return { url: session.url, key: session.key };
   } catch {
      // 壊れた値や、localStorage を使えない環境では未ログインとして扱う
   }
   return null;
}

/** @param {Session} session */
export function saveSession(session) {
   localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: session.url, key: session.key }));
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
