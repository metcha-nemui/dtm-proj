// 画面から呼ぶ操作。repository から読み、ドメインロジックで計算し、保存して notify する。
// 計算そのものは domain/ にあり、ここは読み書きの配線だけを受け持つ。

import * as libraryDomain from './domain/library.js';
import * as projectDomain from './domain/project.js';
import * as taskDomain from './domain/task.js';
import { touch } from './domain/record.js';
import { notify, repo } from './state.js';

// 操作は「読む→計算→保存」なので、並行して走ると後から保存した方が先の変更を消してしまう。
// 1つずつ順番に実行して、それを防ぐ。
let queue = Promise.resolve();
function serial(operation) {
   return (...args) => {
      const result = queue.then(() => operation(...args));
      queue = result.catch(() => {});
      return result;
   };
}

async function load(projectId) {
   const [lanes, tasks] = await Promise.all([repo().getLanes(projectId), repo().getTasks(projectId)]);
   return { lanes, tasks };
}

function find(records, id, label) {
   const record = records.find((r) => r.id === id);
   if (!record) throw new Error(`${label}が見つかりません`);
   return record;
}

// プロジェクトの最終更新を進めて、画面に変更を知らせる
async function changed(projectId) {
   const project = await repo().getProject(projectId);
   if (project) await repo().saveProject(touch(project));
   notify({ projectId });
}

// ---- プロジェクト ----

export const createProject = serial(async ({ title, memo, dueDate, templateId }) => {
   const library = await repo().getLibrary();
   const template = library.templates.find((t) => t.id === templateId) ?? null;
   const { project, lanes, tasks } = projectDomain.createProject({ title, memo, dueDate }, template, library);
   await repo().saveProject(project);
   await repo().saveLanes(lanes);
   await repo().saveTasks(tasks);
   notify({ projectId: project.id });
   return project;
});

export const updateProject = serial(async (projectId, patch) => {
   const project = await repo().getProject(projectId);
   if (!project) throw new Error('プロジェクトが見つかりません');
   await repo().saveProject(projectDomain.updateProject(project, patch));
   notify({ projectId });
});

export const deleteProject = serial(async (projectId) => {
   await repo().deleteProject(projectId);
   notify({ projectId });
});

// ---- レーン ----

export const addSection = serial(async (projectId, { kindId, index, name, empty }) => {
   const [{ lanes }, library, project] = await Promise.all([load(projectId), repo().getLibrary(), repo().getProject(projectId)]);
   const result = projectDomain.addSection({
      projectId,
      lanes,
      // 選べるのは、このプロジェクトのテンプレートの種別だけ
      kind: library.kinds.find((k) => k.id === kindId && k.templateId === project?.templateId) ?? null,
      templateTasks: library.templateTasks,
      index,
      name,
      empty,
   });
   await repo().saveLanes(result.lanes);
   await repo().saveTasks(result.tasks);
   await changed(projectId);
   return result.lane;
});

export const duplicateLane = serial(async (projectId, laneId) => {
   const { lanes, tasks } = await load(projectId);
   const result = projectDomain.duplicateLane(laneId, lanes, tasks);
   await repo().saveLanes(result.lanes);
   await repo().saveTasks(result.tasks);
   await changed(projectId);
   return result.lane;
});

export const renameLane = serial(async (projectId, laneId, name) => {
   const { lanes } = await load(projectId);
   await repo().saveLane(projectDomain.renameLane(find(lanes, laneId, 'レーン'), name));
   await changed(projectId);
});

export const setLaneCollapsed = serial(async (projectId, laneId, collapsed) => {
   const { lanes } = await load(projectId);
   await repo().saveLane(projectDomain.setLaneCollapsed(find(lanes, laneId, 'レーン'), collapsed));
   // 表示の切り替えだけなので、プロジェクトの最終更新は進めない
   notify({ projectId });
});

export const moveLane = serial(async (projectId, laneId, toIndex) => {
   const { lanes } = await load(projectId);
   await repo().saveLanes(projectDomain.moveLane(lanes, laneId, toIndex));
   await changed(projectId);
});

/** @returns 削除したレーンとタスク。restoreLane に渡すと元に戻せる */
export const deleteLane = serial(async (projectId, laneId) => {
   const { lanes, tasks } = await load(projectId);
   const snapshot = { lane: find(lanes, laneId, 'レーン'), tasks: tasks.filter((t) => t.laneId === laneId) };
   projectDomain.assertSection(snapshot.lane, '削除');
   await repo().deleteLane(laneId);
   await changed(projectId);
   return snapshot;
});

export const restoreLane = serial(async ({ lane, tasks }) => {
   await repo().saveLane(lane);
   await repo().saveTasks(tasks);
   await changed(lane.projectId);
});

// ---- タスク ----

export const addTask = serial(async (projectId, laneId, title) => {
   const { lanes, tasks } = await load(projectId);
   const task = taskDomain.addTask(find(lanes, laneId, 'レーン'), tasks.filter((t) => t.laneId === laneId), title);
   await repo().saveTask(task);
   await changed(projectId);
   return task;
});

export const updateTask = serial(async (projectId, taskId, patch) => {
   const { tasks } = await load(projectId);
   await repo().saveTask(taskDomain.updateTask(find(tasks, taskId, 'タスク'), patch));
   await changed(projectId);
});

export const setTaskStatus = serial(async (projectId, taskId, status) => {
   const { tasks } = await load(projectId);
   await repo().saveTask(taskDomain.setStatus(find(tasks, taskId, 'タスク'), status));
   await changed(projectId);
});

export const cycleTaskStatus = serial(async (projectId, taskId) => {
   const { tasks } = await load(projectId);
   await repo().saveTask(taskDomain.cycleStatus(find(tasks, taskId, 'タスク')));
   await changed(projectId);
});

export const moveTask = serial(async (projectId, taskId, toLaneId, toIndex) => {
   const { tasks } = await load(projectId);
   await repo().saveTasks(taskDomain.moveTask(tasks, taskId, toLaneId, toIndex));
   await changed(projectId);
});

/** @returns 削除したタスク。restoreTask に渡すと元に戻せる */
export const deleteTask = serial(async (projectId, taskId) => {
   const { tasks } = await load(projectId);
   const task = find(tasks, taskId, 'タスク');
   await repo().deleteTask(taskId);
   await changed(projectId);
   return task;
});

export const restoreTask = serial(async (task) => {
   await repo().saveTask(task);
   await changed(task.projectId);
});

/** タスクを、所属するレーン(セクション種別、または「全体」)の定番に追加する。 */
export const promoteTask = serial(async (projectId, taskId) => {
   const [{ lanes, tasks }, library, project] = await Promise.all([load(projectId), repo().getLibrary(), repo().getProject(projectId)]);
   if (!project) throw new Error('プロジェクトが見つかりません');
   const task = find(tasks, taskId, 'タスク');
   const templateTask = taskDomain.promoteTask(task, find(lanes, task.laneId, 'レーン'), project, library);
   await repo().saveTemplateTask(templateTask);
   // 変わるのはライブラリだけ。プロジェクトの最終更新は進めない
   notify({ library: true });
   return templateTask;
});

// ---- ライブラリ ----
// コピー方式なので、ここでの変更は作成済みのプロジェクトには影響しない。

const libraryChanged = () => notify({ library: true });

export const addTemplate = serial(async ({ name }) => {
   const { templates } = await repo().getLibrary();
   const template = libraryDomain.newTemplate(templates, { name });
   await repo().saveTemplate(template);
   libraryChanged();
   return template;
});

export const updateTemplate = serial(async (id, patch) => {
   const { templates } = await repo().getLibrary();
   await repo().saveTemplate(libraryDomain.updateTemplate(find(templates, id, 'テンプレート'), patch));
   libraryChanged();
});

// テンプレートと、その種別・定番タスクを保存する。種別と定番タスクはテンプレートを参照するので、テンプレートが先
async function saveTemplateWithContents({ template, kinds, templateTasks }) {
   await repo().saveTemplate(template);
   await repo().saveKinds(kinds);
   await repo().saveTemplateTasks(templateTasks);
   libraryChanged();
   return template;
}

/** 種別と定番タスクごと複製する。 */
export const duplicateTemplate = serial(async (id) => {
   const library = await repo().getLibrary();
   return saveTemplateWithContents(libraryDomain.duplicateTemplate(find(library.templates, id, 'テンプレート'), library));
});

/** プロジェクトのいまの構成(セクションの並びとタスク)から、新しいテンプレートを作る。 */
export const saveProjectAsTemplate = serial(async (projectId, name) => {
   const [project, library] = await Promise.all([load(projectId), repo().getLibrary()]);
   return saveTemplateWithContents(libraryDomain.templateFromProject({ name }, project, library));
});

/** 種別と定番タスクも一緒に消す。作成済みのプロジェクトは残る。 */
export const deleteTemplate = serial(async (id) => {
   await repo().deleteTemplate(id);
   libraryChanged();
});

export const addKind = serial(async ({ templateId, name }) => {
   const { kinds } = await repo().getLibrary();
   const kind = libraryDomain.newKind(kinds, { templateId, name });
   await repo().saveKind(kind);
   libraryChanged();
   return kind;
});

export const updateKind = serial(async (kindId, patch) => {
   const { kinds } = await repo().getLibrary();
   await repo().saveKind(libraryDomain.updateKind(find(kinds, kindId, 'セクション種別'), patch));
   libraryChanged();
});

export const moveKind = serial(async (kindId, toIndex) => {
   const { kinds } = await repo().getLibrary();
   await repo().saveKinds(libraryDomain.moveKind(kinds, kindId, toIndex));
   libraryChanged();
});

/** 種別と、その定番タスク、テンプレートの並びからの参照を消す。 */
export const deleteKind = serial(async (kindId) => {
   const { templateTaskIds, templates } = libraryDomain.removeKind(kindId, await repo().getLibrary());
   for (const id of templateTaskIds) await repo().deleteTemplateTask(id);
   await repo().saveTemplates(templates);
   await repo().deleteKind(kindId);
   libraryChanged();
});

export const addTemplateTask = serial(async ({ templateId, kindId, title }) => {
   const { templateTasks } = await repo().getLibrary();
   const templateTask = libraryDomain.newTemplateTask(templateTasks, { templateId, kindId, title });
   await repo().saveTemplateTask(templateTask);
   libraryChanged();
   return templateTask;
});

export const updateTemplateTask = serial(async (id, patch) => {
   const { templateTasks } = await repo().getLibrary();
   await repo().saveTemplateTask(libraryDomain.updateTemplateTask(find(templateTasks, id, '定番タスク'), patch));
   libraryChanged();
});

export const moveTemplateTask = serial(async (id, toIndex) => {
   const { templateTasks } = await repo().getLibrary();
   await repo().saveTemplateTasks(libraryDomain.moveTemplateTask(templateTasks, id, toIndex));
   libraryChanged();
});

/** @returns 削除した定番タスク。restoreTemplateTask に渡すと元に戻せる */
export const deleteTemplateTask = serial(async (id) => {
   const { templateTasks } = await repo().getLibrary();
   const templateTask = find(templateTasks, id, '定番タスク');
   await repo().deleteTemplateTask(id);
   libraryChanged();
   return templateTask;
});

export const restoreTemplateTask = serial(async (templateTask) => {
   await repo().saveTemplateTask(templateTask);
   libraryChanged();
});

