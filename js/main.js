// 起動とルーター。ルーティングはハッシュ方式(#/、#/p/:id、#/p/:id/arrange、#/p/:id/refs、#/templates、#/t/:id、#/settings)。
// 未ログインならログイン画面を出し、ログイン後に保存先(repository)を決めてアプリを始める。

import { clearSession, loadSession, saveSession } from './session.js';
import { createIndexedDbRepository } from './store/indexeddb.js';
import { checkSchema, NewerSchemaError, upgradeStorage } from './store/repository.js';
import { ensureSeeded } from './store/seed.js';
import { createSupabaseRepository } from './store/supabase.js';
import { repo, setRepository } from './state.js';
import * as arrangement from './ui/arrangement.js';
import * as board from './ui/board.js';
import { h } from './ui/components/dom.js';
import * as login from './ui/login.js';
import * as projectList from './ui/projectList.js';
import * as references from './ui/references.js';
import * as settings from './ui/settings.js';
import * as templateList from './ui/templateList.js';

// 各画面は mount(container, params) を持ち、後片付けの関数を返す。
// テンプレートの編集(#/t/:id)は、プロジェクトと同じボードを使う。
const routes = [
   { name: 'projects', pattern: /^\/$/, view: projectList },
   { name: 'projects', pattern: /^\/p\/([^/]+)$/, params: ['id'], view: board },
   { name: 'projects', pattern: /^\/p\/([^/]+)\/arrange$/, params: ['id'], view: arrangement },
   { name: 'projects', pattern: /^\/p\/([^/]+)\/refs$/, params: ['id'], view: references },
   { name: 'templates', pattern: /^\/templates$/, view: templateList },
   { name: 'templates', pattern: /^\/t\/([^/]+)$/, params: ['id'], view: board },
   { name: 'settings', pattern: /^\/settings$/, view: settings },
];

const notFound = {
   name: '',
   view: {
      mount(container) {
         container.append(h('div', { class: 'empty' },
            h('p', null, 'ページが見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'))));
      },
   },
};

export function matchRoute(hash) {
   const path = hash.replace(/^#/, '') || '/';
   for (const route of routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params = {};
      (route.params ?? []).forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { route, params };
   }
   return { route: notFound, params: {} };
}

const app = document.getElementById('app');
const projectsLink = document.querySelector('[data-nav="projects"]');
let started = false;
let unmount = null;
// 閲覧中のプロジェクトの画面(ボード、アレンジ、リファレンス)。テンプレートや設定を見てから「プロジェクト」タブで戻れるように覚えておく。
// プロジェクト一覧(タイトルのリンクや「←」で行ける)を開いたら忘れる。
let currentProjectHash = null;

function render() {
   unmount?.();
   app.replaceChildren();
   app.scrollTop = 0;
   const { route, params } = matchRoute(location.hash);
   unmount = route.view.mount(app, params) ?? null;
   for (const link of document.querySelectorAll('[data-nav]')) {
      link.classList.toggle('is-active', link.dataset.nav === route.name);
   }
   if ([board, arrangement, references].includes(route.view) && route.name === 'projects') currentProjectHash = location.hash;
   else if (route.view === projectList) currentProjectHash = null;
   projectsLink.href = currentProjectHash ?? '#/';
}

// 保存先を用意してアプリを始める。保存先に届かなければ失敗する。
// 保存先のデータが古い形なら、ここで変換する(新しい形なら NewerSchemaError で止まる)
async function start(session) {
   const repository = session.mode === 'supabase' ? createSupabaseRepository(session) : createIndexedDbRepository();
   await upgradeStorage(repository);
   await ensureSeeded(repository);
   setRepository(repository);
   document.body.classList.remove('is-logged-out');
   started = true;
   render();
}

function showLogin() {
   document.body.classList.add('is-logged-out');
   app.replaceChildren();
   login.mount(app, {
      onLogin: async (session) => {
         saveSession(session);
         try {
            await start(session);
         } catch (error) {
            clearSession();
            throw error;
         }
      },
   });
}

// アプリを止めて理由を出す。書き込ませないように、画面ごと差し替える
function showStopped(error, { canLogout }) {
   started = false;
   unmount?.();
   unmount = null;
   document.body.classList.add('is-logged-out');
   app.replaceChildren(h('div', { class: 'error-box' },
      h('p', null, error instanceof NewerSchemaError
         ? error.message
         : `データを読み込めませんでした。
${error?.message ?? error}`),
      h('div', { class: 'error-actions' },
         h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() },
            error instanceof NewerSchemaError ? '再読み込み' : '再試行'),
         canLogout && h('button', {
            type: 'button',
            class: 'btn',
            onclick: () => {
               clearSession();
               location.reload();
            },
         }, 'ログアウト'))));
}

async function boot() {
   const session = loadSession();
   if (!session) {
      showLogin();
      return;
   }
   try {
      await start(session);
   } catch (error) {
      console.error(error);
      // 一時的な通信の失敗かもしれないので、ログイン情報は消さずに選んでもらう
      showStopped(error, { canLogout: !(error instanceof NewerSchemaError) });
   }
}

// 開いたままのタブに戻ってきたとき、別の端末やタブが新しいアプリでデータを変換していないか確かめる。
// 古い形のまま書き込むとデータが壊れるので、新しくなっていたら止める
document.addEventListener('visibilitychange', () => {
   if (!started || document.visibilityState !== 'visible') return;
   checkSchema(repo()).catch((error) => {
      // 通信の失敗は、次の操作で改めて分かるので、ここでは止めない
      if (error instanceof NewerSchemaError) showStopped(error, { canLogout: false });
   });
});

window.addEventListener('hashchange', () => {
   if (started) render();
});
boot();
