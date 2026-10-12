// プロジェクトとレーンのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { ORDER_STEP, placeAt, reorder, sortByOrder } from './order.js';
import { newRecord, touch } from './record.js';
import { copyTask, tasksFromTemplates } from './task.js';

/** 既存の名前と重ならない名前を返す。「Aメロ」が既にあれば「Aメロ2」「Aメロ3」…。 */
export function uniqueLaneName(base, existingNames) {
   const used = new Set(existingNames);
   if (!used.has(base)) return base;
   let n = 2;
   while (used.has(`${base}${n}`)) n++;
   return `${base}${n}`;
}

/** 締切(YYYY-MM-DD)を正規化する。空や、存在しない日付は null(締切なし)。 */
export function normalizeDueDate(value) {
   const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
   if (!m) return null;
   const [year, month, day] = m.slice(1).map(Number);
   const date = new Date(year, month - 1, day);
   return date.getMonth() === month - 1 && date.getDate() === day ? value : null;
}

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

/** 定番タスクを、種別(kindId)または全体(kindId=null)で絞って登録順に返す。 */
export function templatesFor(templateTasks, kindId) {
   return sortByOrder(templateTasks.filter((t) =>
      kindId ? t.scope === 'kind' && t.kindId === kindId : t.scope === 'global'));
}

function newLane(projectId, fields) {
   return newRecord({ projectId, type: 'section', name: '', kindId: null, order: 0, collapsed: false, ...fields });
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
 * 構成テンプレートからプロジェクトを作る。定番タスクはコピーするので、
 * 後からライブラリを編集しても作成済みのプロジェクトには影響しない。
 * @param {{ title: string, memo?: string, dueDate?: string|null }} input
 * @param {object|null} structure 構成テンプレート。null ならセクションなし(「全体」レーンだけ)
 * @param {{ kinds: object[], templateTasks: object[] }} library
 * @returns {{ project: object, lanes: object[], tasks: object[] }}
 */
export function createProject({ title, memo = '', dueDate = null }, structure, library) {
   const project = newRecord({
      title: title.trim() || '無題のプロジェクト',
      memo,
      dueDate: normalizeDueDate(dueDate),
   });
   const kinds = new Map(library.kinds.map((k) => [k.id, k]));
   const lanes = [];
   const tasks = [];
   const names = () => lanes.map((l) => l.name);

   // 「全体」レーンは構成テンプレートに関係なく必ず作り、全体の定番タスクを入れる
   const global = newGlobalLane(project.id);
   lanes.push(global);
   tasks.push(...tasksFromTemplates(global, templatesFor(library.templateTasks, null)));

   // ライブラリから削除済みの種別は飛ばす
   const sectionKinds = (structure?.sections ?? []).map((id) => kinds.get(id)).filter(Boolean);
   sectionKinds.forEach((kind, i) => {
      const lane = newLane(project.id, {
         name: uniqueLaneName(kind.name, names()),
         kindId: kind.id,
         order: (i + 1) * ORDER_STEP,
      });
      lanes.push(lane);
      tasks.push(...tasksFromTemplates(lane, templatesFor(library.templateTasks, kind.id)));
   });

   return { project, lanes, tasks };
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
 * セクションを追加する。種別の定番タスクも一緒にコピーする(empty なら空で追加)。
 * @param {object} input
 * @param {string} input.projectId
 * @param {object[]} input.lanes プロジェクトの全レーン
 * @param {object|null} input.kind セクション種別。null なら種別なし
 * @param {object[]} input.templateTasks
 * @param {number} [input.index] セクションの並びでの挿入位置。省略すると末尾
 * @param {string} [input.name] 省略すると種別名から自動で付ける
 * @param {boolean} [input.empty]
 * @returns {{ lane: object, lanes: object[], tasks: object[] }} lanes は保存が必要なレーン(新レーンを含む)
 */
export function addSection({ projectId, lanes, kind, templateTasks, index, name, empty = false }) {
   const sections = lanes.filter((l) => l.type === 'section');
   const draft = newLane(projectId, {
      name: uniqueLaneName(name?.trim() || kind?.name || 'セクション', lanes.map((l) => l.name)),
      kindId: kind?.id ?? null,
   });
   const changed = placeAt(sections, draft, index);
   const lane = changed.find((l) => l.id === draft.id);
   const tasks = empty || !kind ? [] : tasksFromTemplates(lane, templatesFor(templateTasks, kind.id));
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
   const base = source.name.replace(/\d+$/, '') || source.name;
   const draft = newLane(source.projectId, {
      type: source.type,
      name: uniqueLaneName(base, lanes.map((l) => l.name)),
      kindId: source.kindId,
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
