// URL(ハッシュ)と保存先のモードの対応。オンライン(Supabase)は接頭辞なし、オフライン(このブラウザの IndexedDB)は #/offline で始まる。
// 再読み込みしても同じ保存先で開けるように、モードは URL に持つ(接頭辞のない既定がオンライン)。

import { currentMode } from './state.js';

const OFFLINE_PREFIX = '/offline';

/**
 * @param {string} hash location.hash
 * @returns {{ mode: 'online'|'offline', path: string }} path はモードの接頭辞を除いたもの(#/offline なら '/')
 */
export function parseHash(hash) {
   const path = hash.replace(/^#/, '') || '/';
   if (path === OFFLINE_PREFIX || path.startsWith(`${OFFLINE_PREFIX}/`)) {
      return { mode: 'offline', path: path.slice(OFFLINE_PREFIX.length) || '/' };
   }
   return { mode: 'online', path };
}

/**
 * アプリ内のリンク先。既定は、いま開いている保存先の中の画面。
 * @param {string} path '/'、'/p/:id' など
 * @param {'online'|'offline'} [mode]
 */
export function href(path, mode = currentMode()) {
   if (mode !== 'offline') return `#${path}`;
   return `#${OFFLINE_PREFIX}${path === '/' ? '' : path}`;
}
