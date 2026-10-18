// .mid をクリップに読み込む(FL Studio のピアノロールで書き出した、1トラックのものを想定)。
// ファイルを選ぶ →(ノートのあるトラックが複数なら)トラックを選ぶ →(クリップに収まらなければ)伸ばすかを選ぶ → ノートを置き換える。
// ピアノロールには元に戻す機能がないので、置き換える前のノートと長さはトーストから戻せるようにする。

import * as actions from '../actions.js';
import { canPlace } from '../domain/arrangement.js';
import { notesBars, parseMidiFile } from '../domain/midi.js';
import { repo } from '../state.js';
import { choiceDialog } from './components/dialog.js';
import { h } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';

/** ファイルを選ばせて、クリップのノートを .mid の中身に置き換える。 */
export function importMidiToClip(projectId, clipId) {
   const picker = h('input', {
      type: 'file',
      accept: '.mid,.midi,audio/midi',
      onchange: () => {
         const [file] = picker.files;
         if (file) importFile(projectId, clipId, file).catch(reportError);
      },
   });
   picker.click();
}

async function importFile(projectId, clipId, file) {
   const parsed = parseMidiFile(await file.arrayBuffer());
   if (!parsed.tracks.length) throw new Error(`「${file.name}」にはノートがありません`);
   const source = parsed.tracks.length === 1 ? parsed.tracks[0] : await chooseTrack(file, parsed.tracks);
   if (!source) return;

   const [clips, markers] = await Promise.all([repo().getClips(projectId), repo().getMarkers(projectId)]);
   const clip = clips.find((c) => c.id === clipId);
   if (!clip) throw new Error('クリップが見つかりません');
   const needed = notesBars(source.notes);
   let bars = clip.bars;
   if (needed > clip.bars) {
      const choice = await chooseLength(clip, needed, canPlace(clips, { ...clip, bars: needed }, clip.id, markers));
      if (!choice) return;
      if (choice === 'extend') bars = needed;
   }

   const before = await actions.replaceClipNotes(projectId, clipId, { notes: source.notes, bars });
   const message = [
      `${source.notes.length}個のノートを読み込みました`,
      parsed.skipped && 'CC・ピッチベンドなどは読み込んでいません',
      parsed.otherMeter && '拍子は 4/4 として読み込みました',
   ].filter(Boolean).join('。');
   showToast(message, {
      actionLabel: '元に戻す',
      onAction: () => actions.replaceClipNotes(projectId, clipId, before).catch(reportError),
   });
}

// ノートのあるトラック(トラックとチャンネルの組)が複数あるときに、1つを選ばせる
async function chooseTrack(file, tracks) {
   const value = await choiceDialog({
      title: '読み込むトラックを選ぶ',
      message: `「${file.name}」には、ノートのあるトラックが${tracks.length}本あります。クリップに読み込むものを1つ選んでください。`,
      choices: tracks.map((t, i) => ({
         value: String(i),
         label: `${t.name || `トラック${i + 1}`}(${t.notes.length}音)`,
         primary: i === 0,
      })),
   });
   return value == null ? null : tracks[Number(value)];
}

// 読み込むノートがクリップに収まらないときに、クリップを伸ばすかを選ばせる
function chooseLength(clip, needed, canExtend) {
   return choiceDialog({
      title: 'クリップに収まりません',
      message: `読み込むノートは${needed}小節ぶんあり、クリップ(${clip.bars}小節)より長くなります。`,
      choices: [
         {
            value: 'extend',
            label: `クリップを${needed}小節に伸ばす`,
            primary: true,
            disabled: !canExtend,
            note: canExtend ? null : 'ほかのクリップと重なるか、セクションマーカーの範囲の外に出るので、伸ばせません。',
         },
         {
            value: 'keep',
            label: '長さはそのまま',
            note: 'はみ出したノートは消さずに持ち、鳴らしません(あとで伸ばせば鳴ります)。',
         },
      ],
   });
}
