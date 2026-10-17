// 画面から呼ぶ操作。repository から読み、ドメインロジックで計算し、保存して notify する。
// 計算そのものは domain/ にあり、ここは読み書きの配線だけを受け持つ。

import * as arrangementDomain from './domain/arrangement.js';
import * as midiDomain from './domain/midi.js';
import * as projectDomain from './domain/project.js';
import * as taskDomain from './domain/task.js';
import { touch } from './domain/record.js';
import { notify, repo } from './state.js';
import { watchSlow } from './ui/components/slowNotice.js';

// 操作は「読む→計算→保存」なので、並行して走ると後から保存した方が先の変更を消してしまう。
// 1つずつ順番に実行して、それを防ぐ。
// 通信に時間が掛かったときは、処理中・完了を画面に知らせる(watchSlow)。
let queue = Promise.resolve();
function serial(operation) {
   return (...args) => {
      const result = queue.then(() => operation(...args));
      queue = result.catch(() => {});
      return watchSlow(result);
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

// アレンジ(クリップ・トラック・マーカー)やセクションの変更を、ボードの連動タスクに反映する。
// 揃え方は domain の syncClipTasks が決め、ここでは読んで保存するだけ
async function syncArrangement(projectId) {
   const [{ lanes, tasks }, tracks, clips, markers] = await Promise.all([
      load(projectId), repo().getTracks(projectId), repo().getClips(projectId), repo().getMarkers(projectId),
   ]);
   const { save, remove } = arrangementDomain.syncClipTasks({ lanes, tracks, clips, markers, tasks });
   if (save.length) await repo().saveTasks(save);
   for (const id of remove) await repo().deleteTask(id);
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

// ---- スケール(転調)----

async function changeScales(projectId, change) {
   const project = await repo().getProject(projectId);
   if (!project) throw new Error('プロジェクトが見つかりません');
   await repo().saveProject(projectDomain.updateProject(project, { scales: change(midiDomain.projectScales(project)) }));
   notify({ projectId });
}

/** その小節にスケールを置く(あれば変える)。 */
export const setScale = serial(async (projectId, bar, scale) => (
   changeScales(projectId, (scales) => midiDomain.setScaleAt(scales, bar, scale))));

export const moveScale = serial(async (projectId, fromBar, toBar) => (
   changeScales(projectId, (scales) => midiDomain.moveScale(scales, fromBar, toBar))));

/** 転調を消す。元に戻せるように、消したスケールを返す。 */
export const deleteScale = serial(async (projectId, bar) => {
   let deleted = null;
   await changeScales(projectId, (scales) => {
      deleted = scales.find((s) => s.bar === bar);
      return midiDomain.removeScale(scales, bar);
   });
   return deleted;
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

/** @returns 削除したレーンとタスク、レーンを指していたマーカー。restoreLane に渡すと元に戻せる */
export const deleteLane = serial(async (projectId, laneId) => {
   const [{ lanes, tasks }, markers] = await Promise.all([load(projectId), repo().getMarkers(projectId)]);
   const snapshot = {
      lane: find(lanes, laneId, 'レーン'),
      tasks: tasks.filter((t) => t.laneId === laneId),
      markers: markers.filter((m) => m.laneId === laneId),
   };
   projectDomain.assertSection(snapshot.lane, '削除');
   // 連動タスクも、レーンのタスクとして一緒に消える
   await repo().deleteLane(laneId);
   // マーカーが消えて、クリップの属するセクションが変わることがある
   await syncArrangement(projectId);
   await changed(projectId);
   return snapshot;
});

export const restoreLane = serial(async ({ lane, tasks, markers = [] }) => {
   // 消している間に、同じクリップの連動タスクが別のセクションに作られていたら、消したときのもの(状態を持っている)を残す
   const clipIds = new Set(tasks.map((t) => t.clipId).filter(Boolean));
   for (const task of await repo().getTasks(lane.projectId)) {
      if (clipIds.has(task.clipId)) await repo().deleteTask(task.id);
   }
   await repo().saveLane(lane);
   await repo().saveTasks(tasks);
   // 消している間に同じ小節へ別のマーカーを置いていたら、そちらを残す
   const taken = new Set((await repo().getMarkers(lane.projectId)).map((m) => m.bar));
   await repo().saveMarkers(markers.filter((m) => !taken.has(m.bar)));
   await syncArrangement(lane.projectId);
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

// ---- アレンジ(トラック・クリップ・マーカー) ----
// プロジェクトだけが持つ。クリップは、属するセクションのレーンに連動タスクとして出る。
// クリップ・トラック・マーカーを変えたら、syncArrangement で連動タスクを揃える。

export const addTrack = serial(async (projectId, name = '') => {
   const track = arrangementDomain.addTrack(projectId, await repo().getTracks(projectId), name);
   await repo().saveTrack(track);
   await changed(projectId);
   return track;
});

export const renameTrack = serial(async (projectId, trackId, name) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.renameTrack(find(tracks, trackId, 'トラック'), name));
   // 連動タスクのタイトルにトラック名が入っている
   await syncArrangement(projectId);
   await changed(projectId);
});

/** トラックの音(音色・音量・パン・ドラムか)を変える。patch は { program?, volume?, pan?, drum? } */
export const updateTrackSound = serial(async (projectId, trackId, patch) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.updateTrackSound(find(tracks, trackId, 'トラック'), patch));
   await changed(projectId);
});

/** トラックのミュート・ソロを変える。patch は { mute?, solo? } */
export const updateTrackMix = serial(async (projectId, trackId, patch) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.updateTrackMix(find(tracks, trackId, 'トラック'), patch));
   await changed(projectId);
});

export const moveTrack = serial(async (projectId, trackId, toIndex) => {
   await repo().saveTracks(arrangementDomain.moveTrack(await repo().getTracks(projectId), trackId, toIndex));
   await changed(projectId);
});

/** @returns 削除したトラックとクリップ、クリップの連動タスク。restoreTrack に渡すと元に戻せる */
export const deleteTrack = serial(async (projectId, trackId) => {
   const [tracks, clips, tasks] = await Promise.all([
      repo().getTracks(projectId), repo().getClips(projectId), repo().getTasks(projectId),
   ]);
   const track = find(tracks, trackId, 'トラック');
   const trackClips = clips.filter((c) => c.trackId === trackId);
   const clipIds = new Set(trackClips.map((c) => c.id));
   const snapshot = { track, clips: trackClips, tasks: tasks.filter((t) => clipIds.has(t.clipId)) };
   // 子(連動タスク)を先に消す。途中で失敗しても、もう一度消せば揃う
   for (const task of snapshot.tasks) await repo().deleteTask(task.id);
   await repo().deleteTrack(trackId);
   await changed(projectId);
   return snapshot;
});

export const restoreTrack = serial(async ({ track, clips, tasks = [] }) => {
   await repo().saveTrack(track);
   await repo().saveClips(clips);
   await repo().saveTasks(tasks);
   await syncArrangement(track.projectId);
   await changed(track.projectId);
});

export const addClip = serial(async (projectId, trackId, { startBar, bars, name }) => {
   const [tracks, clips, markers] = await Promise.all([
      repo().getTracks(projectId), repo().getClips(projectId), repo().getMarkers(projectId),
   ]);
   const clip = arrangementDomain.addClip(find(tracks, trackId, 'トラック'), clips, { startBar, bars, name }, markers);
   await repo().saveClip(clip);
   await syncArrangement(projectId);
   await changed(projectId);
   return clip;
});

export const updateClip = serial(async (projectId, clipId, patch) => {
   const clips = await repo().getClips(projectId);
   await repo().saveClip(arrangementDomain.updateClip(find(clips, clipId, 'クリップ'), patch));
   await syncArrangement(projectId);
   await changed(projectId);
});

/** ピアノロールで編集したノートを保存する(クリップのノートを丸ごと置き換える)。 */
export const setClipNotes = serial(async (projectId, clipId, notes) => {
   const clips = await repo().getClips(projectId);
   await repo().saveClip(arrangementDomain.setClipNotes(find(clips, clipId, 'クリップ'), notes));
   // ノートは連動タスクに関わらないので、syncArrangement は要らない
   await changed(projectId);
});

/** クリップの移動・伸縮・トラック間の移動。patch は { trackId?, startBar?, bars? } */
export const placeClip = serial(async (projectId, clipId, patch) => {
   const [tracks, clips, markers] = await Promise.all([
      repo().getTracks(projectId), repo().getClips(projectId), repo().getMarkers(projectId),
   ]);
   if (patch.trackId) find(tracks, patch.trackId, 'トラック');
   await repo().saveClip(arrangementDomain.placeClip(clips, clipId, patch, markers));
   await syncArrangement(projectId);
   await changed(projectId);
});

/** @returns 削除したクリップと、その連動タスク({ clip, task })。restoreClip に渡すと元に戻せる */
export const deleteClip = serial(async (projectId, clipId) => {
   const [clips, tasks] = await Promise.all([repo().getClips(projectId), repo().getTasks(projectId)]);
   const clip = find(clips, clipId, 'クリップ');
   const task = tasks.find((t) => t.clipId === clipId) ?? null;
   if (task) await repo().deleteTask(task.id);
   await repo().deleteClip(clipId);
   await changed(projectId);
   return { clip, task };
});

export const restoreClip = serial(async ({ clip, task }) => {
   // 消している間に、同じ場所へ別のクリップを置いていたら戻せない。
   // セクションの外でも戻す(取り消しは、新しく置くことではないので)
   const clips = await repo().getClips(clip.projectId);
   if (!arrangementDomain.canPlace(clips, clip, clip.id)) throw new Error('同じ場所にほかのクリップがあるので、元に戻せません');
   await repo().saveClip(clip);
   if (task) await repo().saveTask(task);
   await syncArrangement(clip.projectId);
   await changed(clip.projectId);
});

export const addMarker = serial(async (projectId, laneId, bar) => {
   const [{ lanes }, markers] = await Promise.all([load(projectId), repo().getMarkers(projectId)]);
   const marker = arrangementDomain.addMarker(projectId, markers, find(lanes, laneId, 'セクション'), bar);
   await repo().saveMarker(marker);
   await syncArrangement(projectId);
   await changed(projectId);
   return marker;
});

/** マーカーの小節か、指すセクションを変える。patch は { bar?, laneId? } */
export const updateMarker = serial(async (projectId, markerId, { bar, laneId }) => {
   const [{ lanes }, markers] = await Promise.all([load(projectId), repo().getMarkers(projectId)]);
   const lane = laneId ? find(lanes, laneId, 'セクション') : null;
   await repo().saveMarker(arrangementDomain.updateMarker(markers, markerId, { bar, lane }));
   await syncArrangement(projectId);
   await changed(projectId);
});

/**
 * マーカーを消す。区間にあったクリップは、ほかの区間に入らなければ無所属になる
 * (連動タスクは消さずにボードから隠し、区間に戻ったら状態ごと戻る)。
 * @returns 削除したマーカー。restoreMarker に渡すと元に戻せる
 */
export const deleteMarker = serial(async (projectId, markerId) => {
   const marker = find(await repo().getMarkers(projectId), markerId, 'マーカー');
   await repo().deleteMarker(markerId);
   await syncArrangement(projectId);
   await changed(projectId);
   return marker;
});

export const restoreMarker = serial(async (marker) => {
   const markers = await repo().getMarkers(marker.projectId);
   if (markers.some((m) => m.bar === marker.bar)) throw new Error(`${marker.bar}小節目にほかのマーカーがあるので、元に戻せません`);
   await repo().saveMarker(marker);
   await syncArrangement(marker.projectId);
   await changed(marker.projectId);
});
