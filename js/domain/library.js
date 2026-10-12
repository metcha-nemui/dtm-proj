// ライブラリ(ノウハウ)側のドメインロジック。テンプレートと、その中のセクション種別・定番タスク。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { orderAtEnd, reorder, sortByOrder } from './order.js';
import { laneBaseName, sectionKey, templatesFor } from './project.js';
import { newRecord, touch } from './record.js';

function requireText(value, message) {
   const trimmed = String(value ?? '').trim();
   if (!trimmed) throw new Error(message);
   return trimmed;
}

/** 並べ替え。変更のあったレコードを返す。toIndex は自身を除いた並びでの位置。 */
export function moveInList(items, id, toIndex) {
   return reorder(items, id, toIndex).map((item) => touch(item));
}

// ---- テンプレート ----

export function newTemplate(templates, { name }) {
   return newRecord({
      name: requireText(name, 'テンプレートの名前を入力してください'),
      sections: [],
      order: orderAtEnd(templates),
   });
}

/** @param {{ name?: string, sections?: string[] }} patch */
export function updateTemplate(template, patch) {
   const next = {};
   if ('name' in patch) next.name = requireText(patch.name, 'テンプレートの名前を入力してください');
   if ('sections' in patch) next.sections = [...patch.sections];
   return touch(template, next);
}

/**
 * テンプレートを、種別と定番タスクごと複製する。コピーは別のIDを持つので、
 * 複製したあとで片方を編集しても、もう片方には影響しない。
 * @returns {{ template: object, kinds: object[], templateTasks: object[] }} 保存するレコード
 */
export function duplicateTemplate(template, { templates, kinds, templateTasks }) {
   const copy = newRecord({ name: `${template.name}のコピー`, sections: [], order: orderAtEnd(templates) });
   const kindIds = new Map(); // 元の種別ID → コピーの種別ID
   const copiedKinds = kinds.filter((k) => k.templateId === template.id).map((kind) => {
      const copied = newRecord({ templateId: copy.id, name: kind.name, order: kind.order });
      kindIds.set(kind.id, copied.id);
      return copied;
   });
   const copiedTasks = templateTasks.filter((t) => t.templateId === template.id).map((t) => newRecord({
      templateId: copy.id,
      scope: t.scope,
      kindId: t.kindId ? kindIds.get(t.kindId) : null,
      title: t.title,
      memo: t.memo,
      order: t.order,
   }));
   return {
      template: { ...copy, sections: template.sections.filter((id) => kindIds.has(id)).map((id) => kindIds.get(id)) },
      kinds: copiedKinds,
      templateTasks: copiedTasks,
   };
}

/**
 * プロジェクトのいまの構成から、新しいテンプレートを作る。プロジェクト側は変更しない。
 * 同じ種別のセクション(種別がなければ、末尾の番号を除いた名前が同じもの)は1つの種別にまとめ、
 * その中で最初に出てくるセクションのタスクを定番にする。「全体」レーンのタスクは「全体」の定番になる。
 * @param {{ name: string }} input
 * @param {{ lanes: object[], tasks: object[] }} project
 * @param {{ templates: object[], kinds: object[] }} library
 * @returns {{ template: object, kinds: object[], templateTasks: object[] }} 保存するレコード
 */
export function templateFromProject({ name }, { lanes, tasks }, { templates, kinds }) {
   const template = newRecord({
      name: requireText(name, 'テンプレートの名前を入力してください'),
      sections: [],
      order: orderAtEnd(templates),
   });
   const kindNames = new Map(kinds.map((k) => [k.id, k.name]));
   const tasksAsTemplates = (lane, kindId) => sortByOrder(tasks.filter((t) => t.laneId === lane.id)).map((t, i) => newRecord({
      templateId: template.id,
      scope: kindId ? 'kind' : 'global',
      kindId,
      title: t.title,
      memo: t.memo,
      order: i + 1,
   }));

   const byKey = new Map();
   const templateTasks = [];
   const sections = [];
   for (const lane of sortByOrder(lanes.filter((l) => l.type === 'section'))) {
      const key = sectionKey(lane);
      if (!byKey.has(key)) {
         const kind = newRecord({
            templateId: template.id,
            // 種別がライブラリから消えていたら、セクションの名前から付ける
            name: kindNames.get(lane.kindId) ?? laneBaseName(lane.name),
            order: byKey.size + 1,
         });
         byKey.set(key, kind);
         templateTasks.push(...tasksAsTemplates(lane, kind.id));
      }
      sections.push(byKey.get(key).id);
   }
   for (const lane of lanes.filter((l) => l.type === 'global')) templateTasks.push(...tasksAsTemplates(lane, null));

   return { template: { ...template, sections }, kinds: [...byKey.values()], templateTasks };
}

// ---- セクション種別 ----

/** @param {{ templateId: string, name: string }} input 種別は、属するテンプレートの中の末尾に入る */
export function newKind(kinds, { templateId, name }) {
   return newRecord({
      templateId,
      name: requireText(name, '種別の名前を入力してください'),
      order: orderAtEnd(kinds.filter((k) => k.templateId === templateId)),
   });
}

export function updateKind(kind, patch) {
   const next = {};
   if ('name' in patch) next.name = requireText(patch.name, '種別の名前を入力してください');
   return touch(kind, next);
}

/** 同じテンプレートの種別の中で並べ替える。 */
export function moveKind(kinds, id, toIndex) {
   const target = kinds.find((k) => k.id === id);
   if (!target) return [];
   return moveInList(kinds.filter((k) => k.templateId === target.templateId), id, toIndex);
}

/**
 * 種別を消すときに一緒に片付けるもの。その種別の定番タスクと、テンプレートの並びからの参照。
 * 作成済みプロジェクトのレーンは触らない(コピー方式なので、種別が消えても残る)。
 * @returns {{ templateTaskIds: string[], templates: object[] }} templates は保存が必要なもの
 */
export function removeKind(kindId, { templateTasks, templates }) {
   return {
      templateTaskIds: templateTasks.filter((t) => t.kindId === kindId).map((t) => t.id),
      templates: templates
         .filter((s) => s.sections.includes(kindId))
         .map((s) => touch(s, { sections: s.sections.filter((id) => id !== kindId) })),
   };
}

// ---- 定番タスク ----

/** @param {{ templateId: string, kindId: string|null, title: string }} input kindId が null なら「全体」の定番 */
export function newTemplateTask(templateTasks, { templateId, kindId, title }) {
   return newRecord({
      templateId,
      scope: kindId ? 'kind' : 'global',
      kindId: kindId ?? null,
      title: requireText(title, 'タイトルを入力してください'),
      memo: '',
      order: orderAtEnd(templatesFor(templateTasks, templateId, kindId ?? null)),
   });
}

export function updateTemplateTask(templateTask, patch) {
   const next = {};
   if ('title' in patch) next.title = requireText(patch.title, 'タイトルを入力してください');
   if ('memo' in patch) next.memo = patch.memo;
   return touch(templateTask, next);
}

/** 同じ系統(同じテンプレートの、種別ごとまたは「全体」)の中で並べ替える。 */
export function moveTemplateTask(templateTasks, id, toIndex) {
   const target = templateTasks.find((t) => t.id === id);
   if (!target) return [];
   return moveInList(templatesFor(templateTasks, target.templateId, target.kindId), id, toIndex);
}
