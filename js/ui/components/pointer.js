// ポインタでのドラッグの共通部分。アレンジ・ピアノロール・ガントチャート・つまみで使う。

/**
 * 押してから離すまでのポインタを追う。target がポインタを捕まえるので、要素の外へ出ても追える。
 * 離すか取り消されたら、リスナーを外してから onEnd(e) を呼ぶ(取り消しは e.type が 'pointercancel')。
 * 返す関数を呼ぶと、onEnd を呼ばずに追うのをやめる(ピアノロールで、2本目の指でピンチに切り替えるとき)。
 * @param {Element} target
 * @param {PointerEvent} down
 * @param {{ onMove?: (e: PointerEvent) => void, onEnd?: (e: PointerEvent) => void }} handlers
 * @returns {() => void}
 */
export function trackPointer(target, down, { onMove, onEnd }) {
   target.setPointerCapture(down.pointerId);
   const move = (e) => onMove?.(e);
   const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
   };
   const end = (e) => {
      stop();
      onEnd?.(e);
   };
   target.addEventListener('pointermove', move);
   target.addEventListener('pointerup', end);
   target.addEventListener('pointercancel', end);
   return stop;
}

/**
 * 範囲選択の枠。from と to を対角とする矩形に box を合わせ、その範囲を返す(座標は box の親の中での px)。
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
export function drawMarquee(box, from, to) {
   const left = Math.min(from.x, to.x);
   const right = Math.max(from.x, to.x);
   const top = Math.min(from.y, to.y);
   const bottom = Math.max(from.y, to.y);
   Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
   return { left, right, top, bottom };
}
