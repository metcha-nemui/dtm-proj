// 設定 #/settings — UIテーマ、音源と再生の負荷(このブラウザだけ)、保存先(ログイン状態)と、JSONのエクスポート/インポート。

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
   audioStatus, clearSoundFont, DEFAULT_VOICE_CAP, isWindows, loadPlaybackOption, loadVoiceCap, MAX_VOICE_CAP,
   MIN_VOICE_CAP, onSynthChange, playbackOptionChoices, refreshSoundSource, resetAudio, savePlaybackOption,
   saveVoiceCap, setSoundFont, soundSource, WINDOWS_GM_DLS,
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

// 再生の負荷。スマホなどで再生が途切れるときに、軽くする設定と、作り直す(パニック)ボタン。
// データではなく、このブラウザの設定
function playbackSection(run, section) {
   // 選択肢から選ぶ設定の行。既定の選択肢には「(既定)」を付ける(既定は端末で違う)
   function choiceRow(name, label, labels, note) {
      const { values, fallback } = playbackOptionChoices(name);
      const buttons = values.map((value, i) => h('button', {
         type: 'button',
         class: 'project-tab',
         role: 'radio',
         onclick: () => {
            run(savePlaybackOption(name, value));
            render();
         },
      }, value === fallback ? `${labels[i]}(既定)` : labels[i]));
      function render() {
         const current = loadPlaybackOption(name);
         values.forEach((value, i) => {
            buttons[i].classList.toggle('is-active', value === current);
            buttons[i].setAttribute('aria-checked', String(value === current));
         });
      }
      render();
      return h('div', { class: 'settings-option' },
         h('div', { class: 'settings-inline' }, label,
            h('div', { class: 'project-tabs', role: 'radiogroup', 'aria-label': label }, buttons)),
         h('p', { class: 'muted settings-description' }, note));
   }

   // 同時に鳴らす音の上限。速くない端末で、音が重なる場面に途切れるのを防ぐ
   const voiceCapInput = h('input', {
      type: 'number',
      class: 'input settings-number',
      min: String(MIN_VOICE_CAP),
      max: String(MAX_VOICE_CAP),
      step: '1',
      value: String(loadVoiceCap()),
      'aria-label': '同時に鳴らす音の上限',
      onchange: () => {
         const cap = Math.round(Number(voiceCapInput.value));
         if (voiceCapInput.value === '' || !Number.isFinite(cap)) {
            voiceCapInput.value = String(loadVoiceCap());
            return;
         }
         const clamped = Math.max(MIN_VOICE_CAP, Math.min(cap, MAX_VOICE_CAP));
         saveVoiceCap(clamped);
         voiceCapInput.value = String(clamped);
      },
   });
   const voiceCap = h('div', { class: 'settings-option' },
      h('label', { class: 'settings-inline' }, '同時に鳴らす音の上限', voiceCapInput, '音'),
      h('p', { class: 'muted settings-description' },
         `音が重なる場面で途切れるときは下げます。上限を超えると、古い音・余韻の小さい音から止めます`
         + `(${MIN_VOICE_CAP}〜${MAX_VOICE_CAP}音。この端末の既定は ${DEFAULT_VOICE_CAP}音)。`));


   // いまの鳴らし方。音を鳴らしたあとでないと分からない値もあるので、開いている間は1秒ごとに出し直す
   const status = h('p', { class: 'settings-sound-status' });
   function renderStatus() {
      const { sampleRate, latency, voices, peakVoices } = audioStatus();
      status.textContent = sampleRate === null
         ? 'いま: まだ音を鳴らしていません。'
         : `いま: ${sampleRate} Hz、出力の遅れ ${Math.round(latency * 1000)} ms、鳴っている音 ${voices ?? 0}`
            + `(再生中の最大 ${peakVoices} / 上限 ${loadVoiceCap()})`;
   }
   renderStatus();
   const timer = setInterval(renderStatus, 1000);
   const unsubscribe = onSynthChange(renderStatus);

   const el = section('再生の負荷',
      'スマホなどで再生がブツブツ途切れるときに、合成を軽くします。上の項目から順に試してください。このブラウザにだけ保存されます。',
      h('button', {
         type: 'button',
         class: 'btn',
         onclick: () => run(resetAudio().then(() => showToast('音をリセットしました'))),
      }, icon('rotate-ccw'), '音をリセット'),
      h('span', { class: 'muted settings-summary' },
         '鳴っている音をすべて止め、音の出力と音源を作り直します。止まらない音があるときや、しばらく再生しているうちに途切れるようになったときに。'));
   el.append(
      status,
      choiceRow('effects', 'エフェクト', ['使う', '使わない'],
         'リバーブ・コーラスの計算をやめると軽くなります。使わないと、トラックのリバーブも掛かりません。'),
      voiceCap,
      choiceRow('interpolation', '波形の補間', ['標準', '軽い'], '軽いと、高い音が少し荒れます。'),
      choiceRow('sampleRate', 'サンプリング周波数', ['端末に合わせる', '32 kHz', '22 kHz'],
         '下げると合成が軽くなりますが、高い音がこもります。変えると音源を読み直します(WAV の書き出しには効きません)。'),
      choiceRow('latency', '出力のバッファ', ['小', '中', '大', '特大'],
         '大きいほど一瞬の重さで途切れにくくなりますが、試し弾きの音が遅れます(再生のタイミングはずれません)。'
         + '重さが続く場面には効きにくいです。変えると音源を読み直します。'));
   return { el, unsubscribe: () => { clearInterval(timer); unsubscribe(); } };
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
   const playback = playbackSection(run, section);

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
      h('div', { class: 'page-head' },
         h('div', { class: 'page-head-group' },
            h('a', { class: 'btn btn-icon', href: '#/', 'aria-label': 'プロジェクト一覧へ', title: 'プロジェクト一覧へ' }, icon('arrow-left')),
            h('h1', { class: 'page-title' }, '設定'))),
      section('UIテーマ',
         '画面の明るさを選びます。「システム」では端末の設定(ライト / ダーク)に合わせます。このブラウザにだけ保存されます。',
         h('div', { class: 'project-tabs', role: 'radiogroup', 'aria-label': 'UIテーマ' }, themeButtons)),
      sound.el,
      playback.el,
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
      playback.unsubscribe();
   };
}
