// 日付(時刻なしの 'YYYY-MM-DD')のヘルパー。DOMにもrepositoryにも依存しない。

/** 日付(YYYY-MM-DD)を正規化する。空や、存在しない日付は null(日付なし)。 */
export function normalizeDate(value) {
   const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
   if (!m) return null;
   const [year, month, day] = m.slice(1).map(Number);
   const date = new Date(year, month - 1, day);
   return date.getMonth() === month - 1 && date.getDate() === day ? value : null;
}

/** 端末の日付を 'YYYY-MM-DD' にする(時刻は見ない)。 */
export function toDateString(date) {
   const pad = (n) => String(n).padStart(2, '0');
   return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 'YYYY-MM-DD' を、端末の時刻でその日の 0:00 にする
function toLocalDate(dateString) {
   const [year, month, day] = dateString.split('-').map(Number);
   return new Date(year, month - 1, day);
}

/** 日付を n 日ずらす(n は負でもよい)。 */
export function addDays(dateString, n) {
   const date = toLocalDate(dateString);
   date.setDate(date.getDate() + n);
   return toDateString(date);
}

/** from から to までの日数。同じ日なら 0、to が前なら負の数。 */
export function daysBetween(from, to) {
   // 夏時間のある地域では1日が24時間ちょうどにならないので、丸める
   return Math.round((toLocalDate(to) - toLocalDate(from)) / 86400000);
}

/**
 * from の翌日から to までに含まれる土日の日数。to が from 以前なら 0。
 * 数える範囲は daysBetween と同じ(「あと◯日」のうち、土日が何日あるか)。
 */
export function weekendDaysBetween(from, to) {
   const days = daysBetween(from, to);
   if (days <= 0) return 0;
   // 丸ごとの週には土日が2日ずつあるので、端数の日だけ曜日を見る
   let count = Math.floor(days / 7) * 2;
   const start = toLocalDate(from).getDay();
   for (let i = 1; i <= days % 7; i++) {
      const weekday = (start + i) % 7;
      if (weekday === 0 || weekday === 6) count++;
   }
   return count;
}
