// 初期データ(シード)。内容は仮置きで、ユーザーが自分で育てる前提。
// IDは固定にしてある。どの保存先でも同じ初期データになり、テストからも名指しできる。

// 種別は [キー, 名前, 定番タスク]。sections は種別のキーを並び順どおりに。
const TEMPLATES = [
   {
      key: 'vocal',
      name: '歌モノ',
      kinds: [
         ['intro', 'イントロ', []],
         ['verse', 'Aメロ', ['コード確定', 'メロ確定', 'ドラム', 'ベース']],
         ['bridge', 'Bメロ', []],
         ['chorus', 'サビ', ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス']],
         ['interlude', '間奏', []],
         ['c', 'Cメロ', []],
         ['outro', 'アウトロ', []],
      ],
      sections: ['intro', 'verse', 'bridge', 'chorus', 'interlude', 'verse', 'bridge', 'chorus', 'c', 'chorus', 'outro'],
      global: ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し'],
   },
   {
      key: 'inst',
      name: 'インスト',
      kinds: [['generic', '汎用', []]],
      sections: ['generic', 'generic', 'generic', 'generic'],
      global: ['テンポ・キー決定', '仮タイトル', 'ミックス', 'マスタリング', '書き出し'],
   },
];

/** @returns {import('./repository.js').Library} */
export function buildSeed(now = new Date().toISOString()) {
   const stamp = { createdAt: now, updatedAt: now };
   const templates = [];
   const kinds = [];
   const templateTasks = [];

   TEMPLATES.forEach((source, i) => {
      const templateId = `seed-template-${source.key}`;
      const kindId = (key) => `seed-kind-${source.key}-${key}`;
      const addTasks = (key, titles) => titles.forEach((title, n) => templateTasks.push({
         id: `seed-task-${source.key}-${key ?? 'global'}-${n + 1}`,
         templateId,
         scope: key ? 'kind' : 'global',
         kindId: key ? kindId(key) : null,
         title,
         memo: '',
         order: n + 1,
         ...stamp,
      }));

      templates.push({ id: templateId, name: source.name, sections: source.sections.map(kindId), order: i + 1, ...stamp });
      source.kinds.forEach(([key, name, titles], n) => {
         kinds.push({ id: kindId(key), templateId, name, order: n + 1, ...stamp });
         addTasks(key, titles);
      });
      addTasks(null, source.global);
   });

   return { templates, kinds, templateTasks };
}

/** 初回起動時だけ初期データを入れる。 */
export async function ensureSeeded(repository) {
   if (await repository.getMeta('seeded')) return false;
   const seed = buildSeed();
   await repository.saveTemplates(seed.templates);
   await repository.saveKinds(seed.kinds);
   await repository.saveTemplateTasks(seed.templateTasks);
   await repository.setMeta('seeded', true);
   return true;
}
