// ログイン画面。Supabase の Project URL と公開キーを入力してもらい、接続できたらログイン扱いにする。
// 入力値はこのブラウザの localStorage に保存する(session.js)。ユーザー認証ではなく、擬似ログイン。

import { normalizeProjectUrl } from '../session.js';
import { checkConnection } from '../store/supabase.js';
import { autoFocus, h, icon } from './components/dom.js';

/**
 * @param {HTMLElement} container
 * @param {{ onLogin: (session: import('../session.js').Session) => Promise<void> }} options
 *   onLogin はアプリの起動まで行う。失敗したら reject する
 */
export function mount(container, { onLogin }) {
   // ブラウザのパスワード管理に覚えさせやすいように、URL をユーザー名、公開キーをパスワードとして扱う
   const url = h('input', {
      class: 'input', id: 'login-url', name: 'url', type: 'url', required: true,
      placeholder: 'https://xxxx.supabase.co', autocomplete: 'username', spellcheck: false,
   });
   const key = h('input', {
      class: 'input', id: 'login-key', name: 'key', type: 'password', required: true,
      placeholder: 'eyJ… または sb_publishable_…', autocomplete: 'current-password',
   });
   const error = h('p', { class: 'login-error', role: 'alert', hidden: true });
   const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('log-in'), 'ログイン');
   const local = h('button', { type: 'button', class: 'btn btn-ghost' }, 'ログインせずに使う(このブラウザにだけ保存)');

   async function login(makeSession) {
      error.hidden = true;
      submit.disabled = true;
      local.disabled = true;
      try {
         await onLogin(await makeSession());
      } catch (e) {
         error.textContent = e?.message ?? String(e);
         error.hidden = false;
         submit.disabled = false;
         local.disabled = false;
      }
   }

   local.addEventListener('click', () => login(() => ({ mode: 'local' })));

   container.append(h('div', { class: 'login-page' },
      h('form', {
         class: 'card login-card',
         onsubmit: (e) => {
            e.preventDefault();
            login(async () => {
               const session = { mode: 'supabase', url: normalizeProjectUrl(url.value), key: key.value.trim() };
               await checkConnection(session);
               return session;
            });
         },
      },
      h('h1', { class: 'login-title' }, 'ログイン'),
      h('p', { class: 'muted login-lead' },
         'データの保存先にする Supabase プロジェクトの Project URL と公開キーを入力します。入力した値はこのブラウザに保存されます。'),
      h('div', { class: 'field' },
         h('label', { class: 'field-label', for: 'login-url' }, 'Project URL'),
         url),
      h('div', { class: 'field' },
         h('label', { class: 'field-label', for: 'login-key' }, '公開キー(anon / publishable key)'),
         key),
      error,
      h('div', { class: 'login-actions' }, submit, local))));

   autoFocus(url);
}
