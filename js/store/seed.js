// 初期データ(シード)。内容は仮置きで、ユーザーが自分で育てる前提。
// IDは固定にしてある。どの保存先でも同じ初期データになり、テストからも名指しできる。

const KINDS = [
   ['intro', 'イントロ'],
   ['verse', 'Aメロ'],
   ['bridge', 'Bメロ'],
   ['chorus', 'サビ'],
   ['interlude', '間奏'],
   ['c', 'Cメロ'],
   ['outro', 'アウトロ'],
   ['generic', '汎用'],
];

const KIND_TASKS = {
   chorus: ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス'],
   verse: ['コード確定', 'メロ確定', 'ドラム', 'ベース'],
};

const GLOBAL_TASKS = ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し'];

const STRUCTURES = [
   ['vocal', '歌モノ', ['intro', 'verse', 'bridge', 'chorus', 'interlude', 'verse', 'bridge', 'chorus', 'c', 'chorus', 'outro']],
   ['inst', 'インスト', ['generic', 'generic', 'generic', 'generic']],
];

const kindId = (key) => `seed-kind-${key}`;

/** @returns {import('./repository.js').Library} */
export function buildSeed(now = new Date().toISOString()) {
   const stamp = { createdAt: now, updatedAt: now };

   const kinds = KINDS.map(([key, name], i) => ({ id: kindId(key), name, order: i + 1, ...stamp }));

   const templateTask = (id, scope, kind, title, i) => ({
      id, scope, kindId: kind, title, memo: '', order: i + 1, ...stamp,
   });
   const templateTasks = [
      ...Object.entries(KIND_TASKS).flatMap(([key, titles]) =>
         titles.map((title, i) => templateTask(`seed-task-${key}-${i + 1}`, 'kind', kindId(key), title, i))),
      ...GLOBAL_TASKS.map((title, i) => templateTask(`seed-task-global-${i + 1}`, 'global', null, title, i)),
   ];

   const structures = STRUCTURES.map(([key, name, sections], i) => ({
      id: `seed-structure-${key}`, name, sections: sections.map(kindId), order: i + 1, ...stamp,
   }));

   return { kinds, templateTasks, structures };
}

/** 初回起動時だけ初期データを入れる。 */
export async function ensureSeeded(repository) {
   if (await repository.getMeta('seeded')) return false;
   const seed = buildSeed();
   await repository.saveKinds(seed.kinds);
   await repository.saveTemplateTasks(seed.templateTasks);
   await repository.saveStructures(seed.structures);
   await repository.setMeta('seeded', true);
   return true;
}
