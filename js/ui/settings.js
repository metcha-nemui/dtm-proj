// 設定 #/settings — UIテーマ、音源(このブラウザだけ)、保存先(ログイン状態)と、JSONのエクスポート/インポート。

import { clearSession, loadSession } from '../session.js';
import { notify, repo } from '../state.js';
import { migrate } from '../store/repository.js';
import { loadTheme, setTheme, THEMES } from '../theme.js';
import { loadIdleMinutes, MAX_IDLE_MINUTES, saveIdleMinutes } from './idleTimer.js';
import { confirmDialog } from './components/dialog.js';
import { h, icon } from './components/dom.js';
import { watchSlow } from './components/slowNotice.js';
import { reportError, showToast } from './components/toast.js';
import {
   clearSoundFont, isWindows, onSynthChange, refreshSoundSource, setSoundFont, soundSource, WINDOWS_GM_DLS,
} from '../synth.js';

const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function describe(data) {
   return `プロジェクト${data.projects.length}件、タスク${data.tasks.length}件`;
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
   // インポートは actions.js を通らないので、ここで時間の掛かり具合を見張る
   await watchSlow(repo().importAll(data));
   notify();
   showToast('インポートしました');
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

// 音源(アレンジの再生とピアノロールの試し弾きに使う)。このブラウザにだけ保存する
function soundFontSection(run, section) {
   const status = h('p', { class: 'settings-sound-status' });
   const removeButton = h('button', {
      type: 'button',
      class: 'btn',
      onclick: () => run(clearSoundFont().then(() => showToast('音源を削除しました'))),
   }, icon('trash-2'), '削除');
   const picker = h('input', {
      type: 'file',
      accept: '.sf2,.sf3,.dls',
      hidden: true,
      onchange: () => {
         const [file] = picker.files;
         picker.value = '';
         if (!file) return;
         status.textContent = `「${file.name}」を読み込んでいます…`;
         run(setSoundFont(file).then(() => showToast(`「${file.name}」を音源にしました`)).finally(render));
      },
   });

   // Windows には MSGS と同じ音色の gm.dls がある。ブラウザからは自動では読めないので、選び方を案内する
   const windowsHint = isWindows() && h('div', { class: 'settings-sound-hint muted' },
      h('p', null, 'Windows では、次のファイルを選ぶと Microsoft GS Wavetable Synth と同じ音で鳴ります。'
         + 'ファイルを選ぶ画面の「ファイル名」欄にこのパスを貼り付けて開くと、すぐに選べます。'),
      h('div', { class: 'settings-sound-path' },
         h('code', null, WINDOWS_GM_DLS),
         h('button', {
            type: 'button',
            class: 'btn btn-icon',
            title: 'パスをコピー',
            'aria-label': 'パスをコピー',
            onclick: () => run(navigator.clipboard.writeText(WINDOWS_GM_DLS).then(() => showToast('パスをコピーしました'))),
         }, icon('copy'))));

   function render() {
      const source = soundSource();
      if (source === undefined) {
         status.textContent = '読み込み中…';
      } else {
         status.textContent = source ? `いまの音源: ${source.name}(${megabytes(source.size)})` : '音源は選ばれていません。';
      }
      removeButton.hidden = !source;
   }

   const unsubscribe = onSynthChange(render);
   run(refreshSoundSource());
   render();
   const el = section('音源',
      '手持ちの SoundFont(.sf2 / .sf3)や DLS(.dls)を読み込んで、アレンジの再生とピアノロールの試し弾きに使います。このブラウザにだけ保存されます。',
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => picker.click() }, icon('upload'), 'ファイルを選ぶ…'),
      removeButton,
      picker);
   el.append(status, windowsHint || '');
   return { el, unsubscribe };
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

   // UIテーマはデータではなく、このブラウザの設定。押したらすぐに当てる
   const themeButtons = THEMES.map((t) => h('button', {
      type: 'button',
      class: 'project-tab',
      role: 'radio',
      onclick: () => {
         setTheme(t.key);
         renderTheme();
      },
   }, icon(t.icon), t.label));
   function renderTheme() {
      const current = loadTheme();
      THEMES.forEach((t, i) => {
         const checked = t.key === current;
         themeButtons[i].classList.toggle('is-active', checked);
         themeButtons[i].setAttribute('aria-checked', String(checked));
      });
   }
   renderTheme();
   const sound = soundFontSection(run, section);

   // アレンジ画面の「編集から 〜」を出し始めるまでの分数。データではなく、このブラウザの設定
   const idleInput = h('input', {
      type: 'number',
      class: 'input settings-number',
      min: '0',
      max: String(MAX_IDLE_MINUTES),
      step: '1',
      value: String(loadIdleMinutes()),
      'aria-label': '表示し始めるまでの分数',
      onchange: () => {
         const minutes = Math.round(Number(idleInput.value));
         if (idleInput.value === '' || !Number.isFinite(minutes)) {
            idleInput.value = String(loadIdleMinutes());
            return;
         }
         const clamped = Math.max(0, Math.min(minutes, MAX_IDLE_MINUTES));
         saveIdleMinutes(clamped);
         idleInput.value = String(clamped);
      },
   });

   container.append(h('div', { class: 'page settings-page' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, '設定')),
      section('UIテーマ',
         '画面の明るさを選びます。「システム」では端末の設定(ライト / ダーク)に合わせます。このブラウザにだけ保存されます。',
         h('div', { class: 'project-tabs', role: 'radiogroup', 'aria-label': 'UIテーマ' }, themeButtons)),
      sound.el,
      section('編集していない時間',
         `アレンジ画面で、最後に編集してからこの時間が過ぎると、ツールバーに経過時間を出します。0 にすると出しません(1〜${MAX_IDLE_MINUTES}分)。このブラウザにだけ保存されます。`,
         h('label', { class: 'settings-inline' }, idleInput, '分')),
      remote
         ? section('保存先: Supabase',
            `${session.url} に保存しています。ログアウトすると、このブラウザから Project URL と公開キーを消します。Supabase 上のデータは残ります。`,
            h('button', { type: 'button', class: 'btn', onclick: logout }, icon('log-out'), 'ログアウト'))
         : section('保存先: このブラウザ',
            'ログインしていません。データはこのブラウザの中(IndexedDB)だけに保存されていて、ブラウザのデータを消すと失われます。'
            + 'Supabase にログインすると保存先が切り替わります。このブラウザのデータは残りますが、自動では移りません(移すには、エクスポートしてからログイン後にインポートします)。',
            h('button', { type: 'button', class: 'btn', onclick: logout }, icon('log-in'), 'Supabase にログイン')),
      section('エクスポート',
         'すべてのプロジェクトを、1つのJSONファイルに書き出します。バックアップや、別のブラウザ・端末への移行に使います。',
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
   return () => {
      alive = false;
      sound.unsubscribe();
   };
}
