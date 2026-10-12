// 画面から呼ぶ操作。repository から読み、ドメインロジックで計算し、保存して notify する。
// 計算そのものは domain/ にあり、ここは読み書きの配線だけを受け持つ。

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

// ---- プロジェクトとテンプレート ----
// テンプレートは「ステータスを使わないプロジェクト」。編集と削除は、プロジェクトと同じ操作を使う。

async function saveBoard({ project, lanes, tasks }) {
   await repo().saveProject(project);
   await repo().saveLanes(lanes);
   await repo().saveTasks(tasks);
   notify({ projectId: project.id });
   return project;
}

/** templateId のテンプレートを丸ごとコピーして作る。なければ空の「全体」レーンだけ。 */
export const createProject = serial(async ({ title, memo, dueDate, templateId }) => {
   const source = templateId ? await load(templateId) : null;
   return saveBoard(projectDomain.createProject({ title, memo, dueDate }, source));
});

/** 空のテンプレートを作る。 */
export const createTemplate = serial(async ({ name }) => saveBoard(projectDomain.createTemplate({ name })));

/** テンプレートを丸ごと複製する。 */
export const duplicateTemplate = serial(async (templateId) => {
   const [template, source] = await Promise.all([repo().getProject(templateId), load(templateId)]);
   if (!template) throw new Error('テンプレートが見つかりません');
   return saveBoard(projectDomain.createTemplate({ name: `${template.title}のコピー`, memo: template.memo }, source));
});

/** プロジェクトのいまの構成(レーンとタスク)を丸ごとコピーして、新しいテンプレートを作る。 */
export const saveProjectAsTemplate = serial(async (projectId, name) => (
   saveBoard(projectDomain.createTemplate({ name }, await load(projectId)))));

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

/**
 * セクションを追加する。from を渡すと、そのセクション(テンプレートのもの)をタスクごと取り込む。
 * @param {string} projectId
 * @param {{ index?: number, name?: string, from?: { projectId: string, laneId: string }|null }} options
 */
export const addSection = serial(async (projectId, { index, name, from = null }) => {
   const { lanes } = await load(projectId);
   let source = null;
   if (from) {
      const origin = await load(from.projectId);
      source = {
         lane: find(origin.lanes, from.laneId, '取り込み元のセクション'),
         tasks: origin.tasks.filter((t) => t.laneId === from.laneId),
      };
   }
   const result = projectDomain.addSection({ projectId, lanes, index, name, source });
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
