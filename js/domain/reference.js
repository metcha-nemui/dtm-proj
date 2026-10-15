// リファレンス(参考にする楽曲)の曲名。DOMにもrepositoryにも依存しない。
// 曲名は自由入力で、管理用の一覧は持たない。表記揺れを防ぐ補助として、
// 同じプロジェクトのタスクに付いている曲名から候補を出し、ほぼ同じ表記なら既存のものに揃える。

/**
 * 比べるための形にする(保存はしない)。全角・半角、大文字・小文字、空白、記号の違いを無視する。
 * 記号だけの曲名でも空にならないよう、記号を除いて空になるときは空白だけを除いた形を使う。
 */
export function normalizeReference(name) {
   const base = String(name ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
   return base.replace(/[\p{P}\p{S}]/gu, '') || base;
}

/**
 * 曲名の一覧を整える。前後の空白を除き、空のものと、比べて同じになるもの(後から出たほう)を落とす。
 * @param {string[]} names
 */
export function cleanReferences(names) {
   const seen = new Set();
   const result = [];
   for (const raw of names ?? []) {
      const name = String(raw ?? '').trim();
      const key = normalizeReference(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(name);
   }
   return result;
}

/**
 * プロジェクトのタスクに付いている曲名を集める。比べて同じになるものは、最初に見つかった表記にまとめる。
 * よく使われている順に並べる(同じ数なら名前順)。リファレンスを持つ前に作ったタスクには項目がない。
 * @param {object[]} tasks
 * @returns {string[]}
 */
export function collectReferences(tasks) {
   const byKey = new Map();
   for (const task of tasks) {
      for (const name of task.references ?? []) {
         const key = normalizeReference(name);
         if (!key) continue;
         const entry = byKey.get(key) ?? { name, count: 0 };
         entry.count += 1;
         byKey.set(key, entry);
      }
   }
   return [...byKey.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'))
      .map((e) => e.name);
}

/**
 * 入力に合う候補。比べる形で入力を含むものを、前方一致を先に出す(それぞれの中では known の順)。
 * exclude(そのタスクに付いているもの)は出さない。入力が空なら、known をそのまま出す。
 * @param {string} input
 * @param {string[]} known collectReferences の結果
 * @param {string[]} [exclude]
 */
export function suggestReferences(input, known, exclude = []) {
   const excluded = new Set(exclude.map(normalizeReference));
   const candidates = known.filter((name) => !excluded.has(normalizeReference(name)));
   const query = normalizeReference(input);
   if (!query) return candidates;
   const keyed = candidates.map((name) => ({ name, key: normalizeReference(name) }));
   return [
      ...keyed.filter((c) => c.key.startsWith(query)),
      ...keyed.filter((c) => !c.key.startsWith(query) && c.key.includes(query)),
   ].map((c) => c.name);
}

/** 比べて同じになる曲名が known にあれば、その表記を返す。なければ入力(前後の空白を除く)を返す。 */
export function canonicalizeReference(name, known) {
   const trimmed = String(name ?? '').trim();
   const key = normalizeReference(trimmed);
   return known.find((k) => normalizeReference(k) === key) ?? trimmed;
}
