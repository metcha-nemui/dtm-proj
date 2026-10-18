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

// プロジェクトの最終更新を進めて、画面に変更を知らせる。
// listening は、聴くための切り替え(ミュート・ソロ)だけの変更。アレンジ画面の「編集から 〜」は、これを編集に数えない
async function changed(projectId, { listening = false } = {}) {
   const project = await repo().getProject(projectId);
   if (project) await repo().saveProject(touch(project));
   notify({ projectId, listening });
}

// ---- プロジェクト ----

/** 新しいプロジェクトを作る。レーンは空の「全体」レーンだけ。 */
export const createProject = serial(async ({ title, memo, dueDate }) => {
   const { project, lanes } = projectDomain.createProject({ title, memo, dueDate });
   await repo().saveProject(project);
   await repo().saveLanes(lanes);
   notify({ projectId: project.id });
   return project;
});

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
 * 空のセクションを追加する。
 * @param {string} projectId
 * @param {{ index?: number, name?: string }} options
 */
export const addSection = serial(async (projectId, { index, name }) => {
   const { lanes } = await load(projectId);
   const result = projectDomain.addSection({ projectId, lanes, index, name });
   await repo().saveLanes(result.lanes);
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

/**
 * オーディオトラックを追加する。file は選んだファイル({ fileId, name, size, duration })で、中身は先に保存しておく。
 * 連動タスクは作らない(クリップを持たないため)。
 */
export const addAudioTrack = serial(async (projectId, name, file) => {
   const track = arrangementDomain.addAudioTrack(projectId, await repo().getTracks(projectId), name, file);
   await repo().saveTrack(track);
   await changed(projectId);
   return track;
});

/** オーディオトラックのファイルを変える(選び直し)。file は { fileId, name, size, duration } */
export const setTrackAudio = serial(async (projectId, trackId, file) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.setTrackAudio(find(tracks, trackId, 'トラック'), file));
   await changed(projectId);
});

/** オーディオトラックの音声を鳴らし始める位置(曲の頭からの tick)を変える。 */
export const moveTrackAudio = serial(async (projectId, trackId, startTick) => {
   const [project, tracks] = await Promise.all([repo().getProject(projectId), repo().getTracks(projectId)]);
   const track = find(tracks, trackId, 'トラック');
   await repo().saveTrack(arrangementDomain.moveTrackAudio(track, startTick, midiDomain.projectBpm(project)));
   await changed(projectId);
});

export const renameTrack = serial(async (projectId, trackId, name) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.renameTrack(find(tracks, trackId, 'トラック'), name));
   // 連動タスクのタイトルにトラック名が入っている
   await syncArrangement(projectId);
   await changed(projectId);
});

/** トラックの音(音色・音量・パン・ドラムか・ドラムキット)を変える。patch は { program?, volume?, pan?, drum?, kit? } */
export const updateTrackSound = serial(async (projectId, trackId, patch) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.updateTrackSound(find(tracks, trackId, 'トラック'), patch));
   await changed(projectId);
});

/** トラックのミュート・ソロ・リバーブを変える。patch は { mute?, solo?, reverb? } */
export const updateTrackMix = serial(async (projectId, trackId, patch) => {
   const tracks = await repo().getTracks(projectId);
   await repo().saveTrack(arrangementDomain.updateTrackMix(find(tracks, trackId, 'トラック'), patch));
   await changed(projectId, { listening: !('reverb' in patch) });
});

/** 全トラックのミュート・ソロを外す。 */
export const clearTrackMix = serial(async (projectId) => {
   await repo().saveTracks(arrangementDomain.clearTrackMix(await repo().getTracks(projectId)));
   await changed(projectId, { listening: true });
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

/** クリップを複製する(名前・詳細・ノートをコピーした別のクリップ)。place は { trackId, startBar } */
export const duplicateClip = serial(async (projectId, clipId, { trackId, startBar }) => {
   const [tracks, clips, markers] = await Promise.all([
      repo().getTracks(projectId), repo().getClips(projectId), repo().getMarkers(projectId),
   ]);
   arrangementDomain.assertClipTrack(find(tracks, trackId, 'トラック'));
   const clip = arrangementDomain.duplicateClip(find(clips, clipId, 'クリップ'), clips, { trackId, startBar }, markers);
   await repo().saveClip(clip);
   // 連動タスクは、新しいクリップのものとして未着手で作られる(元のステータスは引き継がない)
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

/**
 * クリップのノートを丸ごと置き換え、bars を渡せば長さも変える(.mid の読み込み)。
 * 長さを変えるときは、移動・伸縮と同じく、重なる位置やセクションマーカーの範囲の外にはできない。
 * @returns 変える前の { notes, bars }。同じ操作に渡すと元に戻せる
 */
export const replaceClipNotes = serial(async (projectId, clipId, { notes, bars }) => {
   const [clips, markers] = await Promise.all([repo().getClips(projectId), repo().getMarkers(projectId)]);
   const clip = find(clips, clipId, 'クリップ');
   const before = { notes: clip.notes ?? [], bars: clip.bars };
   const resized = bars && bars !== clip.bars;
   const placed = resized ? arrangementDomain.placeClip(clips, clipId, { bars }, markers) : clip;
   await repo().saveClip(arrangementDomain.setClipNotes(placed, notes));
   // 長さが変わると、どのセクションに出るかが変わることがある
   if (resized) await syncArrangement(projectId);
   await changed(projectId);
   return before;
});

/** クリップの移動・伸縮・トラック間の移動。patch は { trackId?, startBar?, bars? } */
export const placeClip = serial(async (projectId, clipId, patch) => {
   const [tracks, clips, markers] = await Promise.all([
      repo().getTracks(projectId), repo().getClips(projectId), repo().getMarkers(projectId),
   ]);
   if (patch.trackId) arrangementDomain.assertClipTrack(find(tracks, patch.trackId, 'トラック'));
   await repo().saveClip(arrangementDomain.placeClip(clips, clipId, patch, markers));
   await syncArrangement(projectId);
   await changed(projectId);
});

/** 選んだクリップとセクションマーカーを、まとめて横に bars 小節ずらす(複数選択での移動)。selection は { clipIds, markerIds } */
export const shiftSelection = serial(async (projectId, selection, bars) => {
   const [clips, markers] = await Promise.all([repo().getClips(projectId), repo().getMarkers(projectId)]);
   const moved = arrangementDomain.shiftSelection(clips, markers, selection, bars);
   if (moved.clips.length) await repo().saveClips(moved.clips);
   if (moved.markers.length) await repo().saveMarkers(moved.markers);
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
   // 1つのセクションにマーカーは1つだけ。消している間に、同じセクションを別の小節に置いていたら戻さない
   if (markers.some((m) => m.laneId === marker.laneId)) throw new Error('同じセクションのマーカーをほかの小節に置いたので、元に戻せません');
   await repo().saveMarker(marker);
   await syncArrangement(marker.projectId);
   await changed(marker.projectId);
});
