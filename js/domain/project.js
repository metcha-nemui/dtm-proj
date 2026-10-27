// プロジェクトとレーンのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { daysBetween, normalizeDate, toDateString } from './date.js';
import { DEFAULT_BPM, normalizeBpm, normalizeScales } from './midi.js';
import { ORDER_STEP, placeAt, reorder, sortByOrder } from './order.js';
import { newRecord, touch } from './record.js';
import { copyTask } from './task.js';

/** 締切(YYYY-MM-DD)を正規化する。空や、存在しない日付は null(締切なし)。 */
export const normalizeDueDate = normalizeDate;

/**
 * 締切までの日数。今日が締切なら 0、過ぎていれば負の数。締切がなければ null。
 * 時刻は見ず、端末の日付で数える。
 */
export function daysUntilDue(dueDate, today = new Date()) {
   if (!dueDate) return null;
   return daysBetween(toDateString(today), dueDate);
}

function newLane(projectId, fields) {
   return newRecord({ projectId, type: 'section', name: '', order: 0, collapsed: false, ...fields });
}

// セクションに割り振る色。系統の違う9色(Tailwind CSS の 500)と、それぞれを明るくした9色(同 300)。
// 並び順がそのまま割り振る順番になるので、隣どうしが似た色にならない順にしてある。
export const SECTION_COLORS = [
   '#ef4444', // 赤
   '#3b82f6', // 青
   '#22c55e', // 緑
   '#f97316', // オレンジ
   '#8b5cf6', // 紫
   '#14b8a6', // 青緑
   '#ec4899', // ピンク
   '#eab308', // 黄
   '#64748b', // グレー
   '#fca5a5', // 明るい赤
   '#93c5fd', // 明るい青
   '#86efac', // 明るい緑
   '#fdba74', // 明るいオレンジ
   '#c4b5fd', // 明るい紫
   '#5eead4', // 明るい青緑
   '#f9a8d4', // 明るいピンク
   '#fde047', // 明るい黄
   '#cbd5e1', // 明るいグレー
];

/**
 * セクションの色を、並び順にパレットの先頭から1色ずつ割り振る。名前は見ない(同じ名前のセクションも別の色)。
 * パレットを使い切ったら先頭に戻る。
 * 色は保存せず、表示のたびに決める。だから並べ替えると、位置に合わせて色も入れ替わる。
 * @param {object[]} lanes プロジェクトの全レーン
 * @returns {Map<string, string>} レーンID → 色。「全体」レーンは含めない
 */
export function sectionColors(lanes) {
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   return new Map(sections.map((l, i) => [l.id, SECTION_COLORS[i % SECTION_COLORS.length]]));
}

export const GLOBAL_LANE_NAME = '全体';

// 「全体」レーン。すべてのプロジェクトが必ず1本持ち、名前変更・複製・削除はできない。
function newGlobalLane(projectId) {
   return newLane(projectId, { type: 'global', name: GLOBAL_LANE_NAME, order: ORDER_STEP });
}

/** セクション以外(「全体」レーン)には許さない操作の前に呼ぶ。 */
export function assertSection(lane, action) {
   if (lane.type !== 'section') throw new Error(`「${lane.name}」レーンは${action}できません`);
}

/**
 * プロジェクトを作る。レーンは「全体」レーンだけ(「全体」レーンは必ず1本)。
 * @param {{ title: string, memo?: string, dueDate?: string|null }} input
 * @returns {{ project: object, lanes: object[], tasks: object[] }}
 */
export function createProject({ title, memo = '', dueDate = null }) {
   const project = newRecord({
      title: title.trim() || '無題のプロジェクト',
      memo,
      dueDate: normalizeDueDate(dueDate),
      bpm: DEFAULT_BPM,
      scales: normalizeScales([]),
   });
   return { project, lanes: [newGlobalLane(project.id)], tasks: [] };
}

/** タイトル・メモ・締切・BPM(アレンジの再生と書き出しに使う)・スケールの並び(ピアノロールの塗り分けに使う)を編集する。 */
export function updateProject(project, patch) {
   const next = {};
   if ('title' in patch) {
      const title = patch.title.trim();
      if (!title) throw new Error('タイトルを入力してください');
      next.title = title;
   }
   if ('memo' in patch) next.memo = patch.memo;
   if ('dueDate' in patch) next.dueDate = normalizeDueDate(patch.dueDate);
   if ('bpm' in patch) next.bpm = normalizeBpm(patch.bpm);
   if ('scales' in patch) next.scales = normalizeScales(patch.scales);
   return touch(project, next);
}

// id とタイムスタンプだけを新しくしたコピー。ノートなどの配列も含めて、元とは中身を共有しない
function cloneRecord(record, patch) {
   const { id, createdAt, updatedAt, ...fields } = structuredClone(record);
   return newRecord({ ...fields, ...patch });
}

/**
 * プロジェクトを丸ごと複製する(セクション・タスク・アレンジ)。タイトルは「〜のコピー」。
 * タスクのステータス・日付、締切、メモ、リファレンスもそのまま引き継ぐ。レコードどうしのつながり(laneId、trackId、clipId)は新しい id に付け替える。
 * オーディオトラックの音声は新しい fileId にする(同じ id のままだと、元のプロジェクトで消したときに、このブラウザの中身が一緒に消える)。
 * 中身を新しい id へ写すのは呼ぶ側(audioFiles に元と先の組を返す)。
 * @param {{ project: object, lanes: object[], tasks: object[], tracks: object[], clips: object[], markers: object[] }} source
 * @returns {{ project: object, lanes: object[], tasks: object[], tracks: object[], clips: object[], markers: object[],
 *    audioFiles: { from: string, to: string }[] }}
 */
export function duplicateProject({ project, lanes, tasks, tracks, clips, markers }) {
   const copy = cloneRecord(project, { title: `${project.title}のコピー` });
   const projectId = copy.id;
   const laneIds = new Map();
   const trackIds = new Map();
   const clipIds = new Map();
   const audioFiles = [];

   const newLanes = lanes.map((l) => {
      const lane = cloneRecord(l, { projectId });
      laneIds.set(l.id, lane.id);
      return lane;
   });
   const newTracks = tracks.map((t) => {
      const patch = { projectId };
      if (t.audio?.fileId) {
         const fileId = crypto.randomUUID();
         audioFiles.push({ from: t.audio.fileId, to: fileId });
         patch.audio = { ...t.audio, fileId };
      }
      const track = cloneRecord(t, patch);
      trackIds.set(t.id, track.id);
      return track;
   });
   const newClips = clips.map((c) => {
      const clip = cloneRecord(c, { projectId, trackId: trackIds.get(c.trackId) ?? null });
      clipIds.set(c.id, clip.id);
      return clip;
   });
   return {
      project: copy,
      lanes: newLanes,
      tracks: newTracks,
      clips: newClips,
      markers: markers.map((m) => cloneRecord(m, { projectId, laneId: laneIds.get(m.laneId) ?? null })),
      // 無所属の連動タスク(laneId が null)は、そのまま無所属で写す
      tasks: tasks.map((t) => cloneRecord(t, {
         projectId,
         laneId: t.laneId ? laneIds.get(t.laneId) ?? null : null,
         clipId: t.clipId ? clipIds.get(t.clipId) ?? null : null,
      })),
      audioFiles,
   };
}

/**
 * 空のセクションを追加する。
 * @param {object} input
 * @param {string} input.projectId
 * @param {object[]} input.lanes プロジェクトの全レーン
 * @param {number} [input.index] セクションの並びでの挿入位置。省略すると末尾
 * @param {string} [input.name] 省略すると「セクション」。ほかのセクションと同じ名前でもよい(レーンは id で見分ける)
 * @returns {{ lane: object, lanes: object[] }} lanes は保存が必要なレーン(新レーンを含む)
 */
export function addSection({ projectId, lanes, index, name }) {
   const sections = lanes.filter((l) => l.type === 'section');
   const draft = newLane(projectId, { name: name?.trim() || 'セクション' });
   const changed = placeAt(sections, draft, index);
   const lane = changed.find((l) => l.id === draft.id);
   return { lane, lanes: changed.map((l) => (l.id === lane.id ? l : touch(l))) };
}

/**
 * レーンをタスクごと複製し、元のレーンの直後に置く。名前は元と同じ。ステータスは未着手に戻し、メモとリファレンスは引き継ぐ。
 * @returns {{ lane: object, lanes: object[], tasks: object[] }}
 */
export function duplicateLane(laneId, lanes, tasks) {
   const source = lanes.find((l) => l.id === laneId);
   if (!source) throw new Error('レーンが見つかりません');
   assertSection(source, '複製');
   const group = sortByOrder(lanes.filter((l) => l.type === source.type));
   const draft = newLane(source.projectId, {
      type: source.type,
      name: source.name,
   });
   const changed = placeAt(group, draft, group.findIndex((l) => l.id === laneId) + 1);
   const lane = changed.find((l) => l.id === draft.id);
   return {
      lane,
      lanes: changed.map((l) => (l.id === lane.id ? l : touch(l))),
      // 同じプロジェクトの中のコピーなので、リファレンスも引き継ぐ。
      // 連動タスクはコピーしない(マーカーは複製しないので、複製したセクションにはクリップが入らない)
      tasks: tasks.filter((t) => t.laneId === laneId && !t.clipId).map((t) => copyTask(t, lane, { keepReferences: true })),
   };
}

export function renameLane(lane, name) {
   assertSection(lane, '名前を変更');
   const trimmed = name.trim();
   if (!trimmed) throw new Error('名前を入力してください');
   return touch(lane, { name: trimmed });
}

export function setLaneCollapsed(lane, collapsed) {
   return touch(lane, { collapsed });
}

/**
 * レーンを同じ種類(セクション同士・全体レーン同士)の中で並べ替える。
 * @param {number} toIndex 自身を除いた並びでの位置
 * @returns {object[]} 変更のあったレーン
 */
export function moveLane(lanes, laneId, toIndex) {
   const lane = lanes.find((l) => l.id === laneId);
   if (!lane) return [];
   return reorder(lanes.filter((l) => l.type === lane.type), laneId, toIndex).map((l) => touch(l));
}
