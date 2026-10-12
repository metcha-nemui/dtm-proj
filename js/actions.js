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

export const createProject = serial(async ({ title, memo, dueDate, structureId }) => {
   const library = await repo().getLibrary();
   const structure = library.structures.find((s) => s.id === structureId) ?? null;
   const { project, lanes, tasks } = projectDomain.createProject({ title, memo, dueDate }, structure, library);
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
   const [{ lanes }, library] = await Promise.all([load(projectId), repo().getLibrary()]);
   const result = projectDomain.addSection({
      projectId,
      lanes,
      kind: library.kinds.find((k) => k.id === kindId) ?? null,
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
   const [{ lanes, tasks }, library] = await Promise.all([load(projectId), repo().getLibrary()]);
   const task = find(tasks, taskId, 'タスク');
   const templateTask = taskDomain.promoteTask(task, find(lanes, task.laneId, 'レーン'), library.templateTasks);
   await repo().saveTemplateTask(templateTask);
   // 変わるのはライブラリだけ。プロジェクトの最終更新は進めない
   notify({ library: true });
   return templateTask;
});

// ---- ライブラリ ----
// コピー方式なので、ここでの変更は作成済みのプロジェクトには影響しない。

const libraryChanged = () => notify({ library: true });

export const addKind = serial(async ({ name }) => {
   const { kinds } = await repo().getLibrary();
   const kind = libraryDomain.newKind(kinds, { name });
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
   await repo().saveKinds(libraryDomain.moveInList(kinds, kindId, toIndex));
   libraryChanged();
});

/** 種別と、その定番タスク、構成テンプレートからの参照を消す。 */
export const deleteKind = serial(async (kindId) => {
   const { templateTaskIds, structures } = libraryDomain.removeKind(kindId, await repo().getLibrary());
   for (const id of templateTaskIds) await repo().deleteTemplateTask(id);
   await repo().saveStructures(structures);
   await repo().deleteKind(kindId);
   libraryChanged();
});

export const addTemplateTask = serial(async ({ kindId, title }) => {
   const { templateTasks } = await repo().getLibrary();
   const templateTask = libraryDomain.newTemplateTask(templateTasks, { kindId, title });
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

export const addStructure = serial(async ({ name }) => {
   const { structures } = await repo().getLibrary();
   const structure = libraryDomain.newStructure(structures, { name });
   await repo().saveStructure(structure);
   libraryChanged();
   return structure;
});

export const updateStructure = serial(async (id, patch) => {
   const { structures } = await repo().getLibrary();
   await repo().saveStructure(libraryDomain.updateStructure(find(structures, id, '構成テンプレート'), patch));
   libraryChanged();
});

export const deleteStructure = serial(async (id) => {
   await repo().deleteStructure(id);
   libraryChanged();
});
