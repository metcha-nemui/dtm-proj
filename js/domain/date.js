// 日付(時刻なしの 'YYYY-MM-DD')のヘルパー。DOMにもrepositoryにも依存しない。

/** 日付(YYYY-MM-DD)を正規化する。空や、存在しない日付は null(日付なし)。 */
export function normalizeDate(value) {
   const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
   if (!m) return null;
   const [year, month, day] = m.slice(1).map(Number);
   const date = new Date(year, month - 1, day);
   return date.getMonth() === month - 1 && date.getDate() === day ? value : null;
}
