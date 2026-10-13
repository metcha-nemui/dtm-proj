// 初期データ(シード)。テンプレートを2つ入れる。内容は仮置きで、ユーザーが自分で育てる前提。
// テンプレートはプロジェクトと同じ形(プロジェクト + レーン + タスク)で持つ。
// IDは固定にしてある。どの保存先でも同じ初期データになり、テストからも名指しできる。

const VERSE = ['コード確定', 'メロ確定', 'ドラム', 'ベース'];
const CHORUS = [...VERSE, '上モノ', 'コーラス'];

// sections は [キー, 名前, タスク] を並び順どおりに。global は「全体」レーンのタスク。
const TEMPLATES = [
   {
      key: 'vocal',
      name: '歌モノ',
      global: ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し'],
      sections: [
         ['intro', 'イントロ', []],
         ['verse1', 'Aメロ', VERSE],
         ['bridge1', 'Bメロ', []],
         ['chorus1', 'サビ', CHORUS],
         ['interlude', '間奏', []],
         ['verse2', 'Aメロ2', VERSE],
         ['bridge2', 'Bメロ2', []],
         ['chorus2', 'サビ2', CHORUS],
         ['c', 'Cメロ', []],
         ['chorus3', 'サビ3', CHORUS],
         ['outro', 'アウトロ', []],
      ],
   },
   {
      key: 'inst',
      name: 'インスト',
      global: ['テンポ・キー決定', '仮タイトル', 'ミックス', 'マスタリング', '書き出し'],
      sections: [
         ['s1', 'セクション', []],
         ['s2', 'セクション2', []],
         ['s3', 'セクション3', []],
         ['s4', 'セクション4', []],
      ],
   },
];

/** @returns {{ projects: object[], lanes: object[], tasks: object[] }} */
export function buildSeed(now = new Date().toISOString()) {
   const stamp = { createdAt: now, updatedAt: now };
   const projects = [];
   const lanes = [];
   const tasks = [];

   for (const source of TEMPLATES) {
      const projectId = `seed-template-${source.key}`;
      projects.push({ id: projectId, title: source.name, memo: '', dueDate: null, isTemplate: true, ...stamp });

      const addLane = (key, type, name, order, titles) => {
         const laneId = `seed-lane-${source.key}-${key}`;
         lanes.push({ id: laneId, projectId, type, name, order, collapsed: false, ...stamp });
         titles.forEach((title, i) => tasks.push({
            id: `seed-task-${source.key}-${key}-${i + 1}`,
            projectId,
            laneId,
            title,
            memo: '',
            status: 'todo',
            order: i + 1,
            doneAt: null,
            startDate: null,
            endDate: null,
            ...stamp,
         }));
      };
      addLane('global', 'global', '全体', 1, source.global);
      source.sections.forEach(([key, name, titles], i) => addLane(key, 'section', name, i + 1, titles));
   }

   return { projects, lanes, tasks };
}

/** 初回起動時だけ初期データを入れる。 */
export async function ensureSeeded(repository) {
   if (await repository.getMeta('seeded')) return false;
   const seed = buildSeed();
   for (const project of seed.projects) await repository.saveProject(project);
   await repository.saveLanes(seed.lanes);
   await repository.saveTasks(seed.tasks);
   await repository.setMeta('seeded', true);
   return true;
}
