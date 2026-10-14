// アレンジ(DAW のアレンジ画面のように、トラックとクリップを小節単位で並べたもの)のドメインロジック。
// DOMにもrepositoryにも依存しない。受け取ったレコードは変更せず、保存すべき新しいレコードを返す。
// 小節は1始まりの整数。クリップは startBar から bars 小節ぶん(startBar + bars - 1 小節目まで)を占める。

import { assertSection, uniqueLaneName } from './project.js';
import { orderAtEnd, reorder } from './order.js';
import { newRecord, touch } from './record.js';

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
 * ドラッグ中の見た目(置けない位置を赤くする)にも使う。
 * @param {object[]} clips プロジェクトの全クリップ
 * @param {{ trackId: string, startBar: number, bars: number }} place
 * @param {string|null} [ignoreId] 動かしているクリップ自身
 */
export function canPlace(clips, { trackId, startBar, bars }, ignoreId = null) {
   if (!isBar(startBar) || !isBar(bars)) return false;
   const end = startBar + bars - 1;
   return clips.every((c) => c.id === ignoreId || c.trackId !== trackId || clipEnd(c) < startBar || c.startBar > end);
}

function assertPlaceable(clips, place, ignoreId) {
   if (!isBar(place.startBar) || !isBar(place.bars)) throw new Error('小節の指定が正しくありません');
   if (!canPlace(clips, place, ignoreId)) throw new Error('ほかのクリップと重なる位置には置けません');
}

/** クリップを作る。名前は空でもよい。 */
export function addClip(track, clips, { startBar, bars = 1, name = '' }) {
   const place = { trackId: track.id, startBar, bars };
   assertPlaceable(clips, place);
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
 */
export function placeClip(clips, clipId, patch) {
   const clip = clips.find((c) => c.id === clipId);
   if (!clip) throw new Error('クリップが見つかりません');
   const place = {
      trackId: patch.trackId ?? clip.trackId,
      startBar: patch.startBar ?? clip.startBar,
      bars: patch.bars ?? clip.bars,
   };
   assertPlaceable(clips, place, clipId);
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

/**
 * 画面に出す小節数。いちばん後ろのクリップ・マーカーより先に余白を取り、4小節単位に切り上げる。
 * 余白に置けば、次の表示でさらに伸びる(小節数の設定は持たない)。
 */
export function arrangementBars(clips, markers) {
   const last = Math.max(0, ...clips.map(clipEnd), ...markers.map((m) => m.bar));
   return Math.max(MIN_BARS, Math.ceil((last + TAIL_BARS) / 4) * 4);
}
