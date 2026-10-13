// プロジェクトとレーンのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { normalizeDate } from './date.js';
import { ORDER_STEP, placeAt, reorder, sortByOrder } from './order.js';
import { newRecord, touch } from './record.js';
import { copyTask } from './task.js';

/** 既存の名前と重ならない名前を返す。「Aメロ」が既にあれば「Aメロ2」「Aメロ3」…。 */
export function uniqueLaneName(base, existingNames) {
   const used = new Set(existingNames);
   if (!used.has(base)) return base;
   let n = 2;
   while (used.has(`${base}${n}`)) n++;
   return `${base}${n}`;
}

/** 締切(YYYY-MM-DD)を正規化する。空や、存在しない日付は null(締切なし)。 */
export const normalizeDueDate = normalizeDate;

/**
 * 締切までの日数。今日が締切なら 0、過ぎていれば負の数。締切がなければ null。
 * 時刻は見ず、端末の日付で数える。
 */
export function daysUntilDue(dueDate, today = new Date()) {
   if (!dueDate) return null;
   const [year, month, day] = dueDate.split('-').map(Number);
   const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
   return Math.round((new Date(year, month - 1, day) - start) / 86400000);
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
 * キーの並びに、パレットの色を先頭から順に割り振る。同じキーには同じ色。
 * パレットを使い切ったら先頭に戻る。
 * @param {string[]} keys
 * @returns {string[]} keys と同じ並びの色
 */
export function colorsInOrder(keys) {
   const assigned = new Map();
   return keys.map((key) => {
      if (!assigned.has(key)) assigned.set(key, SECTION_COLORS[assigned.size % SECTION_COLORS.length]);
      return assigned.get(key);
   });
}

/**
 * セクションの色を、並び順に割り振る。同じ名前(末尾の番号を除く)のセクションは同じ色。
 * 色は保存せず、表示のたびに決める。だから並べ替えると、位置に合わせて色も入れ替わる。
 * @param {object[]} lanes プロジェクトの全レーン
 * @returns {Map<string, string>} レーンID → 色。「全体」レーンは含めない
 */
export function sectionColors(lanes) {
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const colors = colorsInOrder(sections.map(sectionKey));
   return new Map(sections.map((l, i) => [l.id, colors[i]]));
}

/** レーン名から、重複を避けるために付けた末尾の番号を除く(「サビ2」→「サビ」)。 */
export function laneBaseName(name) {
   return name.replace(/\d+$/, '') || name;
}

/** 「同じ種類のセクション」を見分けるキー。名前から末尾の番号を除いたもの(「サビ」と「サビ2」は同じ)。 */
export function sectionKey(lane) {
   return laneBaseName(lane.name);
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

// レーンとタスクを、新しいIDで別のプロジェクトへコピーする。
// ステータスは未着手に戻し、メモは引き継ぐ。開始日・終了日は引き継がない。折りたたみは解除する。
// source がなければ、空の「全体」レーンだけを作る(「全体」レーンは必ず1本)。
function copyBoard(projectId, source) {
   const lanes = [];
   const tasks = [];
   for (const lane of sortByOrder(source?.lanes ?? [])) {
      const copied = newLane(projectId, { type: lane.type, name: lane.name, order: lane.order });
      lanes.push(copied);
      tasks.push(...source.tasks.filter((t) => t.laneId === lane.id).map((t) => copyTask(t, copied)));
   }
   if (!lanes.some((l) => l.type === 'global')) lanes.unshift(newGlobalLane(projectId));
   return { lanes, tasks };
}

/**
 * プロジェクトを作る。テンプレートのレーンとタスクは丸ごとコピーし、作成元は覚えない。
 * だから、後からテンプレートを編集・削除しても、作成済みのプロジェクトには影響しない。
 * @param {{ title: string, memo?: string, dueDate?: string|null }} input
 * @param {{ lanes: object[], tasks: object[] }|null} [source] テンプレートの中身。なければ空の「全体」レーンだけ
 * @returns {{ project: object, lanes: object[], tasks: object[] }}
 */
export function createProject({ title, memo = '', dueDate = null }, source = null) {
   const project = newRecord({
      title: title.trim() || '無題のプロジェクト',
      memo,
      dueDate: normalizeDueDate(dueDate),
      isTemplate: false,
   });
   return { project, ...copyBoard(project.id, source) };
}

/**
 * テンプレートを作る。テンプレートは「ステータスを使わないプロジェクト」で、レーンとタスクの持ち方は同じ。
 * 新規作成(source なし)、複製、プロジェクトからの保存(どちらも source に元の中身を渡す)で共用する。
 * @param {{ name: string, memo?: string }} input
 * @param {{ lanes: object[], tasks: object[] }|null} [source]
 * @returns {{ project: object, lanes: object[], tasks: object[] }}
 */
export function createTemplate({ name, memo = '' }, source = null) {
   const title = String(name ?? '').trim();
   if (!title) throw new Error('テンプレートの名前を入力してください');
   const project = newRecord({ title, memo, dueDate: null, isTemplate: true });
   return { project, ...copyBoard(project.id, source) };
}

/** タイトル・メモ・締切を編集する。 */
export function updateProject(project, patch) {
   const next = {};
   if ('title' in patch) {
      const title = patch.title.trim();
      if (!title) throw new Error('タイトルを入力してください');
      next.title = title;
   }
   if ('memo' in patch) next.memo = patch.memo;
   if ('dueDate' in patch) next.dueDate = normalizeDueDate(patch.dueDate);
   return touch(project, next);
}

/**
 * セクションを追加する。source を渡すと、そのセクション(テンプレートのものなど)をタスクごと取り込む。
 * 取り込みはコピーで、取り込み元とのつながりは残さない。
 * @param {object} input
 * @param {string} input.projectId
 * @param {object[]} input.lanes プロジェクトの全レーン
 * @param {number} [input.index] セクションの並びでの挿入位置。省略すると末尾
 * @param {string} [input.name] 省略すると、取り込み元の名前(なければ「セクション」)から付ける
 * @param {{ lane: object, tasks: object[] }|null} [input.source] 取り込み元。tasks はそのレーンのタスク
 * @returns {{ lane: object, lanes: object[], tasks: object[] }} lanes は保存が必要なレーン(新レーンを含む)
 */
export function addSection({ projectId, lanes, index, name, source = null }) {
   const sections = lanes.filter((l) => l.type === 'section');
   const base = name?.trim() || (source ? laneBaseName(source.lane.name) : 'セクション');
   const draft = newLane(projectId, { name: uniqueLaneName(base, lanes.map((l) => l.name)) });
   const changed = placeAt(sections, draft, index);
   const lane = changed.find((l) => l.id === draft.id);
   const tasks = (source?.tasks ?? []).map((t) => copyTask(t, lane));
   return { lane, lanes: changed.map((l) => (l.id === lane.id ? l : touch(l))), tasks };
}

/**
 * レーンをタスクごと複製し、元のレーンの直後に置く。ステータスは未着手に戻し、メモは引き継ぐ。
 * @returns {{ lane: object, lanes: object[], tasks: object[] }}
 */
export function duplicateLane(laneId, lanes, tasks) {
   const source = lanes.find((l) => l.id === laneId);
   if (!source) throw new Error('レーンが見つかりません');
   assertSection(source, '複製');
   const group = sortByOrder(lanes.filter((l) => l.type === source.type));
   const draft = newLane(source.projectId, {
      type: source.type,
      name: uniqueLaneName(laneBaseName(source.name), lanes.map((l) => l.name)),
   });
   const changed = placeAt(group, draft, group.findIndex((l) => l.id === laneId) + 1);
   const lane = changed.find((l) => l.id === draft.id);
   return {
      lane,
      lanes: changed.map((l) => (l.id === lane.id ? l : touch(l))),
      tasks: tasks.filter((t) => t.laneId === laneId).map((t) => copyTask(t, lane)),
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
