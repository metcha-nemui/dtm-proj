// アレンジ画面のダイアログとメニューのうち、画面の状態(選択やドラッグ)に関わらないもの。
// トラックの追加・名前変更・音・削除と、スケール(転調)の選択。どれも actions を呼んで保存するだけで、
// 描き直しは保存の通知(subscribe)に任せる。

import * as actions from '../actions.js';
import {
   DRUM_CHANNEL, DRUM_KITS, KEY_NAMES, kitLabel, playbackMessages, projectScales, scaleAt, scaleLabel, SCALE_MODES, trackChannels,
   trackSound,
} from '../domain/midi.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { reportError, showToast } from './components/toast.js';
import { programPicker } from './programPicker.js';
import * as synth from '../synth.js';

const run = (promise) => promise.catch(reportError);

// ---- トラック ----

export async function addTrackDialog(projectId) {
   const values = await formDialog({
      title: 'トラックを追加',
      submitLabel: '追加',
      fields: [{ name: 'name', label: '名前(空欄なら「Track」)', placeholder: '例: ドラム' }],
   });
   if (!values) return;
   const track = await actions.addTrack(projectId, values.name);
   // 足したトラックを見える位置へ
   document.querySelector(`.arr-track[data-track-id="${CSS.escape(track.id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

export async function renameTrackDialog(projectId, track) {
   const values = await formDialog({
      title: '名前を変更',
      fields: [{ name: 'name', label: '名前', value: track.name, required: true }],
   });
   if (values) await actions.renameTrack(projectId, track.id, values.name);
}

// 音色のダイアログで押した音色を、1音(C4)鳴らして聞かせる。トラックの音量・パンで、トラックのチャンネルを使う。
// ドラムのトラック(10ch)では音色が効かないので、1ch で鳴らす(鳴らす前に毎回音色を送るので、1ch のトラックの音は変わらない)
function previewProgram(track, tracks, program) {
   const channel = trackSound(track).drum ? 0 : trackChannels(tracks).get(track.id) ?? 0;
   synth.previewNote(playbackMessages({ ...track, program, drum: false }, channel), channel, 60);
}

// ドラムキットの欄で選んだキットを、スネア(GM のドラムの 38)で鳴らして聞かせる。ドラムのトラックでなくても 10ch で鳴らす
function previewKit(track, kit) {
   synth.previewNote(playbackMessages({ ...track, kit, drum: true }, DRUM_CHANNEL), DRUM_CHANNEL, 38);
}

// ドラムキットの欄。セレクトボックスに、知っているキット(GS の並び)を出す。
// 一覧にない番号のキット(手で書き換えたデータなど)を持っていれば、それも選べるように先頭に足す
function kitSelect(id, track, initial) {
   const kits = DRUM_KITS.some((k) => k.kit === initial) ? DRUM_KITS : [{ kit: initial }, ...DRUM_KITS];
   const select = h('select', { id, class: 'select', onchange: () => previewKit(track, Number(select.value)) },
      kits.map(({ kit }) => h('option', { value: String(kit), selected: kit === initial }, kitLabel(kit))));
   return select;
}

/** トラックの音(音色・ドラムか・ドラムキット)。tracks はチャンネルの割り振り(試し弾き)に使う */
export async function trackSoundDialog(projectId, track, tracks) {
   const sound = trackSound(track);
   const values = await formDialog({
      title: `「${track.name}」の音`,
      message: '音源(設定画面で選んだ SoundFont / DLS)の General MIDI の音色で鳴らします。',
      wide: true,
      fields: [
         { name: 'program', label: '音色', type: 'custom', render: (id) => programPicker(id, sound.program, { onPreview: (program) => previewProgram(track, tracks, program) }) },
         { name: 'drum', label: 'ドラム(10ch で鳴らす。音色は使わず、下のドラムキットで鳴らす)', type: 'checkbox', value: sound.drum },
         { name: 'kit', label: 'ドラムキット(選ぶとスネアを鳴らす)', type: 'custom', render: (id) => kitSelect(id, track, sound.kit) },
      ],
   });
   if (!values) return;
   // 音量・パンはトラック名の下のつまみで変える(ここでは持たない)
   await actions.updateTrackSound(projectId, track.id, {
      program: Number(values.program),
      drum: values.drum,
      kit: Number(values.kit),
   });
}

/** トラックの削除。clips と tasks は、確認ダイアログに出す件数を数えるのに使う */
export async function deleteTrackDialog(projectId, track, { clips, tasks }) {
   const clipIds = new Set(clips.filter((c) => c.trackId === track.id).map((c) => c.id));
   // ボードに出ている連動タスクの数(範囲の外のクリップのものは、ボードに出ていないので数えない)
   const taskCount = tasks.filter((t) => clipIds.has(t.clipId) && t.laneId).length;
   const parts = [clipIds.size && `クリップ${clipIds.size}件`, taskCount && `ボードのタスク${taskCount}件`].filter(Boolean);
   const ok = await confirmDialog({
      title: `「${track.name}」を削除`,
      message: parts.length ? `このトラックの${parts.join('と、')}も一緒に削除します。` : 'このトラックを削除します。',
      okLabel: '削除',
      danger: true,
   });
   if (!ok) return;
   const snapshot = await actions.deleteTrack(projectId, track.id);
   showToast(`「${track.name}」を削除しました`, {
      actionLabel: '元に戻す',
      onAction: () => run(actions.restoreTrack(snapshot)),
   });
}

// ---- スケール ----

/** スケールを選ぶダイアログ。初期値は、その小節でいま効いているスケール */
export async function scaleDialog(project, bar, title) {
   const current = scaleAt(projectScales(project), bar);
   const values = await formDialog({
      title,
      message: 'ピアノロールの行の塗り分けに使います。次の転調まで続きます。',
      fields: [
         {
            name: 'root', label: 'キー', type: 'select', value: String(current.root),
            options: KEY_NAMES.map((name, i) => ({ value: String(i), label: name })),
         },
         { name: 'mode', label: 'Major / Minor', type: 'select', value: current.mode, options: SCALE_MODES },
      ],
   });
   if (values) await actions.setScale(project.id, bar, { root: Number(values.root), mode: values.mode });
}

/** スケールの旗のメニュー。1小節目のスケールは消せない */
export function openScaleMenu(project, scale, anchor) {
   openMenu(anchor, [
      { label: 'スケールを変更…', onSelect: () => run(scaleDialog(project, scale.bar, `${scale.bar}小節目のスケール`)) },
      scale.bar > 1 && {
         label: '転調を削除',
         danger: true,
         onSelect: () => run(actions.deleteScale(project.id, scale.bar).then((deleted) => showToast(
            `${deleted.bar}小節目の転調(${scaleLabel(deleted)})を削除しました`,
            { actionLabel: '元に戻す', onAction: () => run(actions.setScale(project.id, deleted.bar, deleted)) },
         ))),
      },
   ].filter(Boolean));
}
