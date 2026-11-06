// 起動とルーター。ルーティングはハッシュ方式(#/、#/p/:id、#/p/:id/arrange、#/settings)。
// 保存先は URL で決まる。接頭辞なしがオンライン(Supabase)、#/offline で始まればオフライン(このブラウザの IndexedDB)。
// 保存先が変わる画面へ移るときに repository を差し替える。オンラインで未ログインなら、一覧の代わりにログインのフォームを出す。

import { idle } from './actions.js';
import { forgetRepository, NotLoggedInError, repositoryFor } from './modes.js';
import { registerServiceWorker } from './pwa.js';
import { href, parseHash } from './route.js';
import { clearSession, saveSession } from './session.js';
import { checkSchema, NewerSchemaError } from './store/repository.js';
import { currentMode, repo, setRepository } from './state.js';
import { applyTheme, loadTheme } from './theme.js';
import * as arrangement from './ui/arrangement.js';
import * as board from './ui/board.js';
import { updateConnection, watchConnection } from './ui/connectionBanner.js';
import { h } from './ui/components/dom.js';
import * as login from './ui/login.js';
import { listHead } from './ui/modeTabs.js';
import * as projectList from './ui/projectList.js';
import * as settings from './ui/settings.js';

// 各画面は mount(container, params) を持ち、後片付けの関数を返す。
const routes = [
   { pattern: /^\/$/, view: projectList },
   { pattern: /^\/p\/([^/]+)$/, params: ['id'], view: board },
   { pattern: /^\/p\/([^/]+)\/arrange$/, params: ['id'], view: arrangement },
   { pattern: /^\/settings$/, view: settings },
];

const notFound = {
   view: {
      mount(container) {
         container.append(h('div', { class: 'empty' },
            h('p', null, 'ページが見つかりません。'),
            h('p', null, h('a', { href: href('/') }, 'プロジェクト一覧へ'))));
      },
   },
};

export function matchRoute(hash) {
   const { mode, path } = parseHash(hash);
   for (const route of routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params = {};
      (route.params ?? []).forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { mode, route, params };
   }
   return { mode, route: notFound, params: {} };
}

// data-theme は index.html で付け済み。ここではアドレスバーの色(theme-color)を合わせる
applyTheme(loadTheme());

const app = document.getElementById('app');
// repository を差し替え済みの保存先。届かなかったときなどは null(次に開くときに作り直す)
let activeMode = null;
let unmount = null;
// 保存先の用意を待っている間に別の画面へ移ったら、古い方の描画を捨てるための番号
let renderId = 0;

function clear() {
   unmount?.();
   unmount = null;
   app.replaceChildren();
   app.scrollTop = 0;
}

async function render() {
   const id = ++renderId;
   clear();
   const { mode, route, params } = matchRoute(location.hash);
   if (mode !== activeMode) {
      // 前の画面が後片付けで出した保存(ピアノロールのノートなど)を、元の保存先に書き終えてから差し替える
      await idle();
      activeMode = null;
      setRepository(null, mode);
      updateConnection();
      try {
         const repository = await repositoryFor(mode);
         if (id !== renderId) return;
         setRepository(repository, mode);
         activeMode = mode;
      } catch (error) {
         if (id !== renderId) return;
         if (!(error instanceof NotLoggedInError)) console.error(error);
         showUnavailable(mode, error);
         return;
      }
   }
   unmount = route.view.mount(app, params) ?? null;
}

// 保存先を開けないとき。書き込ませないように repository は外したまま、理由を出す。
// 見出しのタブは出すので、オンラインに入れなくてもオフラインへ移れる
function showUnavailable(mode, error) {
   const page = h('div', { class: 'page' }, listHead(mode));
   app.replaceChildren(page);
   if (error instanceof NotLoggedInError) {
      login.mount(page, {
         onLogin: async (session) => {
            saveSession(session);
            forgetRepository('online');
            try {
               await repositoryFor('online');
            } catch (e) {
               clearSession();
               throw e;
            }
            await render();
         },
      });
      return;
   }
   const newer = error instanceof NewerSchemaError;
   page.append(h('div', { class: 'error-box' },
      h('p', null, newer
         ? error.message
         : `データを読み込めませんでした。
${error?.message ?? error}`),
      h('div', { class: 'error-actions' },
         h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, newer ? '再読み込み' : '再試行'),
         // 一時的な通信の失敗かもしれないので、ログイン情報は消さずに選んでもらう
         mode === 'online' && !newer && h('button', {
            type: 'button',
            class: 'btn',
            onclick: () => {
               clearSession();
               forgetRepository('online');
               render();
            },
         }, 'ログアウト'))));
}

// 開いたままのタブに戻ってきたとき、別の端末やタブが新しいアプリでデータを変換していないか確かめる。
// 古い形のまま書き込むとデータが壊れるので、新しくなっていたら止める
document.addEventListener('visibilitychange', () => {
   if (!activeMode || document.visibilityState !== 'visible') return;
   const mode = activeMode;
   checkSchema(repo()).catch((error) => {
      // 通信の失敗は、次の操作で改めて分かるので、ここでは止めない
      if (!(error instanceof NewerSchemaError) || mode !== activeMode) return;
      forgetRepository(mode);
      activeMode = null;
      clear();
      setRepository(null, mode);
      showUnavailable(currentMode(), error);
   });
});

window.addEventListener('hashchange', () => { render(); });
registerServiceWorker();
watchConnection();
render();
