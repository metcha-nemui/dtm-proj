// 起動とルーター。ルーティングはハッシュ方式(#/、#/p/:id、#/templates、#/t/:id、#/settings)。
// 未ログインならログイン画面を出し、ログイン後に保存先(repository)を決めてアプリを始める。

import { clearSession, loadSession, saveSession } from './session.js';
import { createIndexedDbRepository } from './store/indexeddb.js';
import { ensureSeeded } from './store/seed.js';
import { createSupabaseRepository } from './store/supabase.js';
import { setRepository } from './state.js';
import * as board from './ui/board.js';
import { h } from './ui/components/dom.js';
import * as login from './ui/login.js';
import * as projectList from './ui/projectList.js';
import * as settings from './ui/settings.js';
import * as templateList from './ui/templateList.js';

// 各画面は mount(container, params) を持ち、後片付けの関数を返す。
// テンプレートの編集(#/t/:id)は、プロジェクトと同じボードを使う。
const routes = [
   { name: 'projects', pattern: /^\/$/, view: projectList },
   { name: 'projects', pattern: /^\/p\/([^/]+)$/, params: ['id'], view: board },
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
// 閲覧中のプロジェクト。テンプレートや設定を見てから「プロジェクト」タブで戻れるように覚えておく。
// プロジェクト一覧(タイトルのリンクや「←」で行ける)を開いたら忘れる。
let currentProjectId = null;

function render() {
   unmount?.();
   app.replaceChildren();
   app.scrollTop = 0;
   const { route, params } = matchRoute(location.hash);
   unmount = route.view.mount(app, params) ?? null;
   for (const link of document.querySelectorAll('[data-nav]')) {
      link.classList.toggle('is-active', link.dataset.nav === route.name);
   }
   if (route.view === board && route.name === 'projects') currentProjectId = params.id;
   else if (route.view === projectList) currentProjectId = null;
   projectsLink.href = currentProjectId ? `#/p/${encodeURIComponent(currentProjectId)}` : '#/';
}

// 保存先を用意してアプリを始める。保存先に届かなければ失敗する
async function start(session) {
   const repository = session.mode === 'supabase' ? createSupabaseRepository(session) : createIndexedDbRepository();
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
      document.body.classList.add('is-logged-out');
      app.replaceChildren(h('div', { class: 'error-box' },
         h('p', null, `データを読み込めませんでした。\n${error?.message ?? error}`),
         h('div', { class: 'error-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, '再試行'),
            h('button', {
               type: 'button',
               class: 'btn',
               onclick: () => {
                  clearSession();
                  location.reload();
               },
            }, 'ログアウト'))));
   }
}

window.addEventListener('hashchange', () => {
   if (started) render();
});
boot();
