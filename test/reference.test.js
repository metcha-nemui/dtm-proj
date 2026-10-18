// リファレンスの曲名のテスト。test/domain.test.js から読む。

import { duplicateLane } from '../js/domain/project.js';
import {
   canonicalizeReference, cleanReferences, collectReferences, listReferences, normalizeReference, suggestReferences,
} from '../js/domain/reference.js';
import { updateTask } from '../js/domain/task.js';
import { test, assert, equal, fixture } from './helpers.js';

// ---- reference ----

test('normalizeReference: 全角・半角、大文字・小文字、空白、記号の違いを無視する', () => {
   equal(normalizeReference('ｱｲﾄﾞﾙ'), normalizeReference('アイドル'));
   equal(normalizeReference(' Ｂｏｈｅｍｉａｎ  Rhapsody '), 'bohemianrhapsody');
   equal(normalizeReference("Don't Stop Me Now!"), normalizeReference('dont stop me now'));
   equal(normalizeReference('!!!'), '!!!', '記号だけなら記号を残す');
   equal(normalizeReference('  '), '');
});

test('cleanReferences: 空と、表記の違いだけで同じものを落とす(先に出た表記を残す)', () => {
   equal(cleanReferences([' 夜に駆ける ', '', '夜に駆ける', 'Lemon', 'lemon', '   ']), ['夜に駆ける', 'Lemon']);
   equal(cleanReferences(undefined), []);
});

test('collectReferences: プロジェクトの曲名を、よく使う順にまとめる', () => {
   const tasks = [
      { references: ['Lemon', '夜に駆ける'] },
      { references: ['lemon'] },
      {},
      { references: ['アイドル', 'ＬＥＭＯＮ'] },
   ];
   equal(collectReferences(tasks), ['Lemon', 'アイドル', '夜に駆ける']);
});

test('listReferences: 一覧の画面には、まとめた曲名を名前順に出す', () => {
   const tasks = [
      { references: ['夜に駆ける', 'Lemon'] },
      { references: ['lemon', 'アイドル'] },
      {},
   ];
   equal(listReferences(tasks), ['Lemon', 'アイドル', '夜に駆ける']);
   equal(listReferences([]), []);
});

test('suggestReferences: 前方一致を先に、部分一致を後に。付いているものは出さない', () => {
   const known = ['Lemon', 'アイドル', 'Pale Blue', 'Blue Bird'];
   equal(suggestReferences('blue', known), ['Blue Bird', 'Pale Blue']);
   equal(suggestReferences('ｱｲ', known), ['アイドル']);
   equal(suggestReferences('', known, ['lemon']), ['アイドル', 'Pale Blue', 'Blue Bird']);
   equal(suggestReferences('zzz', known), []);
});

test('canonicalizeReference: 表記の違いだけなら既存の表記に揃える', () => {
   const known = ['アイドル', 'Lemon'];
   equal(canonicalizeReference('ｱｲﾄﾞﾙ', known), 'アイドル');
   equal(canonicalizeReference(' LEMON ', known), 'Lemon');
   equal(canonicalizeReference(' 新しい曲 ', known), '新しい曲');
});

test('updateTask: リファレンスを整えて保存する', () => {
   const { tasks } = fixture();
   equal(tasks[0].references, [], '初めはなし');
   equal(updateTask(tasks[0], { references: [' Lemon ', 'lemon', ''] }).references, ['Lemon']);
   equal(updateTask(tasks[0], { title: 'y' }).references, [], '他の項目だけ編集しても変わらない');
});

test('リファレンス: セクションの複製では引き継ぐ', () => {
   const { lanes, tasks } = fixture();
   const withRefs = tasks.map((t) => updateTask(t, { references: ['Lemon'] }));
   const chorus = lanes.find((l) => l.name === 'サビ');
   const source = { lane: chorus, tasks: withRefs.filter((t) => t.laneId === chorus.id) };
   const dup = duplicateLane(chorus.id, lanes, withRefs).tasks;
   assert(dup.length > 0 && dup.every((t) => t.references[0] === 'Lemon'), 'セクションの複製');
   assert(dup[0].references !== source.tasks[0].references, '配列は共有しない');
   // リファレンスを持つ前に作ったタスク(項目がない)でも複製できる
   const { references, ...old } = tasks.find((t) => t.laneId === chorus.id);
   equal(duplicateLane(chorus.id, lanes, [old]).tasks[0].references, []);
});
