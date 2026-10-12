// ライブラリ(ノウハウ)側のドメインロジック。セクション種別、定番タスク、構成テンプレート。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { orderAtEnd, reorder } from './order.js';
import { newRecord, touch } from './record.js';

// 種別の色の選択肢。系統の違う9色(Tailwind CSS の 500)と、それぞれを明るくした9色(同 300)。
// 選択画面では9列に並べるので、上段が基本色、下段がその明るい色になる。
export const KIND_COLORS = [
   { name: '赤', value: '#ef4444' },
   { name: 'オレンジ', value: '#f97316' },
   { name: '黄', value: '#eab308' },
   { name: '緑', value: '#22c55e' },
   { name: '青緑', value: '#14b8a6' },
   { name: '青', value: '#3b82f6' },
   { name: '紫', value: '#8b5cf6' },
   { name: 'ピンク', value: '#ec4899' },
   { name: 'グレー', value: '#64748b' },
   { name: '明るい赤', value: '#fca5a5' },
   { name: '明るいオレンジ', value: '#fdba74' },
   { name: '明るい黄', value: '#fde047' },
   { name: '明るい緑', value: '#86efac' },
   { name: '明るい青緑', value: '#5eead4' },
   { name: '明るい青', value: '#93c5fd' },
   { name: '明るい紫', value: '#c4b5fd' },
   { name: '明るいピンク', value: '#f9a8d4' },
   { name: '明るいグレー', value: '#cbd5e1' },
];

function requireText(value, message) {
   const trimmed = String(value ?? '').trim();
   if (!trimmed) throw new Error(message);
   return trimmed;
}

/** 並べ替え。変更のあったレコードを返す。toIndex は自身を除いた並びでの位置。 */
export function moveInList(items, id, toIndex) {
   return reorder(items, id, toIndex).map((item) => touch(item));
}

// ---- セクション種別 ----

/** 色を省略すると、まだ使われていない色(なければ順繰り)を割り当てる。 */
export function newKind(kinds, { name, color }) {
   const used = new Set(kinds.map((k) => k.color));
   const palette = KIND_COLORS.map((c) => c.value);
   return newRecord({
      name: requireText(name, '種別の名前を入力してください'),
      color: color ?? palette.find((c) => !used.has(c)) ?? palette[kinds.length % palette.length],
      order: orderAtEnd(kinds),
   });
}

export function updateKind(kind, patch) {
   const next = {};
   if ('name' in patch) next.name = requireText(patch.name, '種別の名前を入力してください');
   if ('color' in patch) next.color = patch.color;
   return touch(kind, next);
}

/**
 * 種別を消すときに一緒に片付けるもの。その種別の定番タスクと、構成テンプレートからの参照。
 * 作成済みプロジェクトのレーンは触らない(コピー方式なので、種別が消えても残る)。
 * @returns {{ templateTaskIds: string[], structures: object[] }} structures は保存が必要なもの
 */
export function removeKind(kindId, { templateTasks, structures }) {
   return {
      templateTaskIds: templateTasks.filter((t) => t.kindId === kindId).map((t) => t.id),
      structures: structures
         .filter((s) => s.sections.includes(kindId))
         .map((s) => touch(s, { sections: s.sections.filter((id) => id !== kindId) })),
   };
}

// ---- 定番タスク ----

/** 同じ系統(種別ごと、または全体)の定番タスク。 */
export function templateSiblings(templateTasks, scope, kindId) {
   return templateTasks.filter((t) => t.scope === scope && t.kindId === kindId);
}

/** @param {{ kindId: string|null, title: string }} input kindId が null なら全体の定番 */
export function newTemplateTask(templateTasks, { kindId, title }) {
   const scope = kindId ? 'kind' : 'global';
   return newRecord({
      scope,
      kindId: kindId ?? null,
      title: requireText(title, 'タイトルを入力してください'),
      memo: '',
      order: orderAtEnd(templateSiblings(templateTasks, scope, kindId ?? null)),
   });
}

export function updateTemplateTask(templateTask, patch) {
   const next = {};
   if ('title' in patch) next.title = requireText(patch.title, 'タイトルを入力してください');
   if ('memo' in patch) next.memo = patch.memo;
   return touch(templateTask, next);
}

export function moveTemplateTask(templateTasks, id, toIndex) {
   const target = templateTasks.find((t) => t.id === id);
   if (!target) return [];
   return moveInList(templateSiblings(templateTasks, target.scope, target.kindId), id, toIndex);
}

// ---- 構成テンプレート ----

export function newStructure(structures, { name }) {
   return newRecord({
      name: requireText(name, 'テンプレートの名前を入力してください'),
      sections: [],
      order: orderAtEnd(structures),
   });
}

/** @param {{ name?: string, sections?: string[] }} patch */
export function updateStructure(structure, patch) {
   const next = {};
   if ('name' in patch) next.name = requireText(patch.name, 'テンプレートの名前を入力してください');
   if ('sections' in patch) next.sections = [...patch.sections];
   return touch(structure, next);
}
