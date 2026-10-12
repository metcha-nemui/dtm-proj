// 並び順(fractional indexing)のヘルパー。
// order は小数で持ち、間に挿入するときは前後の中間値を使う。他の行を書き換えずに済む。

export const ORDER_STEP = 1;

export function compareOrder(a, b) {
   return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortByOrder(items) {
   return [...items].sort(compareOrder);
}

/** 末尾に追加するときの order。 */
export function orderAtEnd(items) {
   return items.length ? Math.max(...items.map((i) => i.order)) + ORDER_STEP : ORDER_STEP;
}

/** prev と next の間の order。どちらも null なら先頭の値。 */
export function orderBetween(prev, next) {
   if (prev == null && next == null) return ORDER_STEP;
   if (prev == null) return next - ORDER_STEP;
   if (next == null) return prev + ORDER_STEP;
   return (prev + next) / 2;
}

/**
 * siblings(item 自身を含まない並び)の index 番目に item を置く。
 * 変更が必要なレコードだけを、order を書き換えたコピーで返す(item は必ず含まれる)。
 * 通常は item の1件だけ。中間値が取れなくなったとき(精度切れ・同値)は全体を振り直す。
 */
export function placeAt(siblings, item, index) {
   const sorted = sortByOrder(siblings);
   const i = Math.max(0, Math.min(index ?? sorted.length, sorted.length));
   const prev = sorted[i - 1]?.order ?? null;
   const next = sorted[i]?.order ?? null;
   const order = orderBetween(prev, next);

   const fits = (prev == null || order > prev) && (next == null || order < next);
   if (fits) return [{ ...item, order }];

   const sequence = [...sorted.slice(0, i), item, ...sorted.slice(i)];
   return sequence
      .map((record, n) => ({ ...record, order: (n + 1) * ORDER_STEP }))
      .filter((record, n) => record.id === item.id || record.order !== sequence[n].order);
}

/** items の中で id のレコードを toIndex 番目(自身を除いた並びでの位置)に動かす。 */
export function reorder(items, id, toIndex) {
   const item = items.find((i) => i.id === id);
   if (!item) return [];
   return placeAt(items.filter((i) => i.id !== id), item, toIndex);
}
