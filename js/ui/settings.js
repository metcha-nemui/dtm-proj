// 設定 #/settings — 保存先(ログイン状態)と、JSONのエクスポート/インポート。

import { clearSession, loadSession } from '../session.js';
import { notify, repo } from '../state.js';
import { migrate } from '../store/repository.js';
import { confirmDialog } from './components/dialog.js';
import { h, icon } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';

const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function describe(data) {
   return `プロジェクト${data.projects.length}件、タスク${data.tasks.length}件、`
      + `セクション種別${data.kinds.length}件、定番タスク${data.templateTasks.length}件、構成テンプレート${data.structures.length}件`;
}

function download(filename, text) {
   const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
   h('a', { href: url, download: filename }).click();
   setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
   const data = await repo().exportAll();
   const now = new Date();
   const pad = (n) => String(n).padStart(2, '0');
   const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
   download(`dtm-proj-backup-${stamp}.json`, JSON.stringify(data, null, 2));
   showToast('エクスポートしました');
}

async function importData(file) {
   const data = migrate(await file.text());
   const ok = await confirmDialog({
      title: 'データをインポート',
      message: `現在のデータをすべて削除し、ファイルの内容に置き換えます。元に戻せません。\n\n`
         + `ファイルの内容(${dateFormat.format(new Date(data.exportedAt))} にエクスポート):\n${describe(data)}`,
      okLabel: '置き換える',
      danger: true,
   });
   if (!ok) return;
   await repo().importAll(data);
   notify();
   showToast('インポートしました');
}

export function mount(container) {
   const run = (promise) => promise.catch(reportError);
   const summary = h('p', { class: 'muted settings-summary' }, '読み込み中…');
   const fileInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
      onchange: () => {
         const [file] = fileInput.files;
         fileInput.value = ''; // 同じファイルをもう一度選べるようにする
         if (file) run(importData(file).then(refresh));
      },
   });

   const session = loadSession();
   const remote = session?.mode === 'supabase';
   // ログイン情報を消して読み込み直すと、ログイン画面に戻る
   const logout = () => {
      clearSession();
      location.reload();
   };

   const section = (title, description, ...controls) => h('section', { class: 'card settings-section' },
      h('h2', { class: 'panel-title' }, title),
      h('p', { class: 'muted settings-description' }, description),
      h('div', { class: 'settings-actions' }, controls));

   container.append(h('div', { class: 'page settings-page' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '設定')),
      remote
         ? section('保存先: Supabase',
            `${session.url} に保存しています。ログアウトすると、このブラウザから Project URL と公開キーを消します。Supabase 上のデータは残ります。`,
            h('button', { type: 'button', class: 'btn', onclick: logout }, icon('log-out'), 'ログアウト'))
         : section('保存先: このブラウザ',
            'ログインしていません。データはこのブラウザの中(IndexedDB)だけに保存されていて、ブラウザのデータを消すと失われます。'
            + 'Supabase にログインすると保存先が切り替わります。このブラウザのデータは残りますが、自動では移りません(移すには、エクスポートしてからログイン後にインポートします)。',
            h('button', { type: 'button', class: 'btn', onclick: logout }, icon('log-in'), 'Supabase にログイン')),
      section('エクスポート',
         'すべてのプロジェクトとライブラリを、1つのJSONファイルに書き出します。バックアップや、別のブラウザ・端末への移行に使います。',
         h('button', { type: 'button', class: 'btn btn-primary', onclick: () => run(exportData()) }, icon('download'), 'JSONをエクスポート'),
         summary),
      section('インポート',
         'エクスポートしたJSONファイルを読み込みます。現在のデータはすべて置き換えられます。',
         h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, icon('upload'), 'JSONをインポート…'),
         fileInput)));

   let alive = true;
   async function refresh() {
      const data = await repo().exportAll();
      if (alive) summary.textContent = `現在のデータ: ${describe(data)}`;
   }
   run(refresh());
   return () => { alive = false; };
}
