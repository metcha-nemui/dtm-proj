// アレンジ(DAW のアレンジ画面のように、トラックとクリップを小節単位で並べたもの)のドメインロジック。
// DOMにもrepositoryにも依存しない。受け取ったレコードは変更せず、保存すべき新しいレコードを返す。
// 小節は1始まりの整数。クリップは startBar から bars 小節ぶん(startBar + bars - 1 小節目まで)を占める。

import { assertSection, uniqueLaneName } from './project.js';
import { orderAtEnd, reorder, sortByOrder } from './order.js';
import { newRecord, touch } from './record.js';
import { addClipTask } from './task.js';

export const DEFAULT_TRACK_NAME = 'トラック';
const MIN_BARS = 32; // クリップもマーカーもないときに見せる小節数
const TAIL_BARS = 8; // いちばん後ろの中身より先に空けておく小節数(ここへ置けば、さらに伸びる)

const isBar = (n) => Number.isInteger(n) && n >= 1;

/** クリップが終わる小節(その小節まで占める)。 */
export const clipEnd = (clip) => clip.startBar + clip.bars - 1;

// ---- トラック ----

/** トラックを末尾に追加する。名前が空なら「トラック」。重なったら番号を振る。 */
export function addTrack(projectId, tracks, name = '') {
   const base = String(name ?? '').trim() || DEFAULT_TRACK_NAME;
   return newRecord({
      projectId,
      name: uniqueLaneName(base, tracks.map((t) => t.name)),
      order: orderAtEnd(tracks),
   });
}

export function renameTrack(track, name) {
   const trimmed = String(name ?? '').trim();
   if (!trimmed) throw new Error('名前を入力してください');
   return touch(track, { name: trimmed });
}

/** @param {number} toIndex 自身を除いた並びでの位置 */
export function moveTrack(tracks, trackId, toIndex) {
   return reorder(tracks, trackId, toIndex).map((t) => touch(t));
}

// ---- クリップ ----

/**
 * そこにクリップを置けるか。小節が正しい整数で、同じトラックの他のクリップと重ならなければ置ける。
 * markers を渡すと、セクションマーカーの区間に1小節以上重なることも求める(セクションの外には置かせない。
 * 置いたクリップは、ボードのどこかのセクションにタスクとして出したいため)。
 * ドラッグ中の見た目(置けない位置を赤くする)にも使う。
 * @param {object[]} clips プロジェクトの全クリップ
 * @param {{ trackId: string, startBar: number, bars: number }} place
 * @param {string|null} [ignoreId] 動かしているクリップ自身
 * @param {object[]|null} [markers] プロジェクトの全マーカー
 */
export function canPlace(clips, place, ignoreId = null, markers = null) {
   const { trackId, startBar, bars } = place;
   if (!isBar(startBar) || !isBar(bars)) return false;
   if (markers && !inSection(markers, place)) return false;
   const end = startBar + bars - 1;
   return clips.every((c) => c.id === ignoreId || c.trackId !== trackId || clipEnd(c) < startBar || c.startBar > end);
}

function assertPlaceable(clips, place, ignoreId, markers) {
   if (!isBar(place.startBar) || !isBar(place.bars)) throw new Error('小節の指定が正しくありません');
   if (markers && !inSection(markers, place)) {
      throw new Error(markers.length ? 'セクションマーカーの範囲の外には置けません' : '先にセクションマーカーを置いてください');
   }
   if (!canPlace(clips, place, ignoreId)) throw new Error('ほかのクリップと重なる位置には置けません');
}

/**
 * クリップを作る。名前は空でもよい。
 * @param {object[]|null} [markers] 渡すと、セクションマーカーの区間の外には作らせない
 */
export function addClip(track, clips, { startBar, bars = 1, name = '' }, markers = null) {
   const place = { trackId: track.id, startBar, bars };
   assertPlaceable(clips, place, null, markers);
   return newRecord({ projectId: track.projectId, ...place, name: String(name ?? '').trim(), memo: '' });
}

/** 名前と詳細(memo)を編集する。名前は空でもよい。 */
export function updateClip(clip, patch) {
   const next = {};
   if ('name' in patch) next.name = String(patch.name ?? '').trim();
   if ('memo' in patch) next.memo = patch.memo;
   return touch(clip, next);
}

/**
 * クリップの位置と長さを変える(移動、伸縮、別のトラックへの移動を兼ねる)。省略した項目はそのまま。
 * @param {object[]} clips プロジェクトの全クリップ
 * @param {string} clipId
 * @param {{ trackId?: string, startBar?: number, bars?: number }} patch
 * @param {object[]|null} [markers] 渡すと、セクションマーカーの区間の外へは動かせない
 */
export function placeClip(clips, clipId, patch, markers = null) {
   const clip = clips.find((c) => c.id === clipId);
   if (!clip) throw new Error('クリップが見つかりません');
   const place = {
      trackId: patch.trackId ?? clip.trackId,
      startBar: patch.startBar ?? clip.startBar,
      bars: patch.bars ?? clip.bars,
   };
   assertPlaceable(clips, place, clipId, markers);
   return touch(clip, place);
}

// ---- セクションマーカー ----
// マーカーはボードのセクション(レーン)を指す。名前と色はレーンのものを使い、マーカーには持たせない。
// セクションは、マーカーの小節から次のマーカーの手前まで続く。同じ小節には1つだけ置ける。

function assertFreeBar(markers, bar, ignoreId = null) {
   if (!isBar(bar)) throw new Error('小節の指定が正しくありません');
   if (markers.some((m) => m.id !== ignoreId && m.bar === bar)) throw new Error(`${bar}小節目には、すでにマーカーがあります`);
}

/** マーカーを置く。lane はセクションのレーン(「全体」レーンは置けない)。 */
export function addMarker(projectId, markers, lane, bar) {
   assertSection(lane, 'マーカーに');
   assertFreeBar(markers, bar);
   return newRecord({ projectId, laneId: lane.id, bar });
}

/**
 * マーカーの小節か、指すセクションを変える。
 * @param {{ bar?: number, lane?: object }} patch
 */
export function updateMarker(markers, markerId, { bar, lane }) {
   const marker = markers.find((m) => m.id === markerId);
   if (!marker) throw new Error('マーカーが見つかりません');
   const next = {};
   if (bar != null) {
      assertFreeBar(markers, bar, markerId);
      next.bar = bar;
   }
   if (lane) {
      assertSection(lane, 'マーカーに');
      next.laneId = lane.id;
   }
   return touch(marker, next);
}

/**
 * マーカーを小節順に並べ、それぞれが受け持つ区間を返す(描画用)。
 * 最後のマーカーは totalBars まで続く。
 * @returns {{ marker: object, lane: object|null, from: number, to: number }[]}
 */
export function markerSpans(markers, lanes, totalBars) {
   const sorted = [...markers].sort((a, b) => a.bar - b.bar);
   return sorted.map((marker, i) => ({
      marker,
      lane: lanes.find((l) => l.id === marker.laneId) ?? null,
      from: marker.bar,
      to: Math.max(marker.bar, (sorted[i + 1]?.bar ?? totalBars + 1) - 1),
   }));
}

// マーカーの区間(小節順)。最後の区間は終わりがない(画面の小節数に左右されないように)
function sectionSpans(markers) {
   const sorted = [...markers].sort((a, b) => a.bar - b.bar);
   return sorted.map((m, i) => ({ laneId: m.laneId, from: m.bar, to: (sorted[i + 1]?.bar ?? Infinity) - 1 }));
}

const overlapBars = (span, { startBar, bars }) => (
   Math.max(0, Math.min(span.to, startBar + bars - 1) - Math.max(span.from, startBar) + 1));

/** その位置が、どれかのマーカーの区間に1小節以上重なるか。 */
export function inSection(markers, place) {
   return sectionSpans(markers).some((span) => overlapBars(span, place) > 0);
}

/**
 * クリップが属するセクション(レーンID)。区間と重なる小節数をセクションごとに合計し、いちばん多いもの。
 * 同じセクションをマーカーで何度か使っていれば、その分を足す。同数なら先(左)に出てくるセクション。
 * どの区間にも重ならなければ null(無所属)。
 */
export function clipSection(clip, markers) {
   const totals = new Map(); // 先に出てきたセクションから順に入る
   for (const span of sectionSpans(markers)) {
      const bars = overlapBars(span, clip);
      if (bars) totals.set(span.laneId, (totals.get(span.laneId) ?? 0) + bars);
   }
   let best = null;
   let most = 0;
   for (const [laneId, bars] of totals) {
      if (bars > most) [best, most] = [laneId, bars];
   }
   return best;
}

// ---- ボードの連動タスク ----
// クリップは、属するセクションのレーンに「トラック名: クリップ名」のタスク(連動タスク。clipId を持つ)として出る。
// 名前・詳細・位置はクリップが、ステータス・日付・リファレンス・レーン内の並び順はタスクが持つ。

export const UNTITLED_CLIP = '(無題)';

/** 連動タスクのタイトル。 */
export const clipTaskTitle = (track, clip) => `${track.name}: ${clip.name || UNTITLED_CLIP}`;

/**
 * アレンジの状態に合わせて、連動タスクを作る・直す・消す。何度呼んでも同じ結果になる(途中で保存に失敗しても、次で揃う)。
 * - セクションに入っているクリップに連動タスクがなければ、そのレーンの末尾に作る(無所属なら作らない)。
 * - タイトル・メモ・レーンがクリップと違えば直す。レーンが変わったら(無所属から戻ったときも)新しいレーンの末尾へ。
 * - セクションから外れたら laneId を null にする(無所属)。ステータスと日付は残し、戻ったときに引き継ぐ。
 * - クリップがなくなった連動タスクは消す。1つのクリップに連動タスクが2つあれば、古い方を残す。
 * @returns {{ save: object[], remove: string[] }} 保存するタスクと、消すタスクのID
 */
export function syncClipTasks({ lanes, tracks, clips, markers, tasks }) {
   const sectionById = new Map(lanes.filter((l) => l.type === 'section').map((l) => [l.id, l]));
   const trackById = new Map(tracks.map((t) => [t.id, t]));
   const remove = [];
   const linked = new Map();
   for (const task of [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))) {
      if (!task.clipId) continue;
      if (linked.has(task.clipId)) remove.push(task.id);
      else linked.set(task.clipId, task);
   }

   // 末尾に足す位置を決めるため、ここまでの変更を反映したタスクの一覧を持つ
   let current = tasks.filter((t) => !remove.includes(t.id));
   const save = new Map();
   const put = (task) => {
      save.set(task.id, task);
      current = [...current.filter((t) => t.id !== task.id), task];
   };
   const laneTasks = (laneId, exceptId) => current.filter((t) => t.laneId === laneId && t.id !== exceptId);

   // 同じレーンに何件も足すときの順番を、トラックの並び → 小節の順にする
   const trackRank = new Map(sortByOrder(tracks).map((t, i) => [t.id, i]));
   const ordered = clips.filter((c) => trackById.has(c.trackId))
      .sort((a, b) => trackRank.get(a.trackId) - trackRank.get(b.trackId) || a.startBar - b.startBar);
   const alive = new Set();
   for (const clip of ordered) {
      alive.add(clip.id);
      const lane = sectionById.get(clipSection(clip, markers)) ?? null;
      const fields = { title: clipTaskTitle(trackById.get(clip.trackId), clip), memo: clip.memo ?? '' };
      const task = linked.get(clip.id);
      if (!task) {
         if (lane) put(addClipTask(lane, laneTasks(lane.id), clip.id, fields));
         continue;
      }
      const laneId = lane?.id ?? null;
      const next = {};
      if (task.title !== fields.title) next.title = fields.title;
      if (task.memo !== fields.memo) next.memo = fields.memo;
      if (task.laneId !== laneId) {
         next.laneId = laneId;
         if (lane) next.order = orderAtEnd(laneTasks(lane.id, task.id));
      }
      if (Object.keys(next).length) put(touch(task, next));
   }
   for (const task of linked.values()) {
      if (!alive.has(task.clipId)) remove.push(task.id);
   }
   return { save: [...save.values()], remove };
}

/**
 * 画面に出す小節数。いちばん後ろのクリップ・マーカーより先に余白を取り、4小節単位に切り上げる。
 * 余白に置けば、次の表示でさらに伸びる(小節数の設定は持たない)。
 */
export function arrangementBars(clips, markers) {
   const last = Math.max(0, ...clips.map(clipEnd), ...markers.map((m) => m.bar));
   return Math.max(MIN_BARS, Math.ceil((last + TAIL_BARS) / 4) * 4);
}
