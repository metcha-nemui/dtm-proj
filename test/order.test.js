// 並び順のテスト。test/domain.test.js から読む。

import { orderAtEnd, orderBetween, placeAt, reorder } from '../js/domain/order.js';
import { test, assert, equal, ids, apply, item } from './helpers.js';

// ---- order ----

test('orderBetween: 先頭・末尾・中間', () => {
   equal(orderBetween(null, null), 1);
   equal(orderBetween(null, 4), 3);
   equal(orderBetween(4, null), 5);
   equal(orderBetween(1, 2), 1.5);
});

test('orderAtEnd: 最大値の次', () => {
   equal(orderAtEnd([]), 1);
   equal(orderAtEnd([item('a', 1), item('b', 7.5)]), 8.5);
});

test('placeAt: 通常は1件だけ書き換える', () => {
   const list = [item('a', 1), item('b', 2), item('c', 3)];
   equal(placeAt(list, item('x', 0), 1), [{ id: 'x', order: 1.5 }]);
   equal(placeAt(list, item('x', 0), 0), [{ id: 'x', order: 0 }]);
   equal(placeAt(list, item('x', 0), 99), [{ id: 'x', order: 4 }]);
   equal(placeAt([], item('x', 0), 0), [{ id: 'x', order: 1 }]);
});

test('placeAt: 同じorderが並んでいたら全体を振り直す', () => {
   const list = [item('a', 1), item('b', 1), item('c', 1)];
   const changed = placeAt(list, item('x', 0), 1);
   equal(ids(apply([...list, item('x', 0)], changed)), ['a', 'x', 'b', 'c']);
});

test('placeAt: 精度が尽きても順序が壊れない', () => {
   let list = [item('a', 1), item('b', 2)];
   for (let n = 0; n < 200; n++) {
      const x = item(`x${n}`, 0);
      list = apply([...list, x], placeAt(list, x, 1));
      equal(ids(list)[1], `x${n}`, `${n}回目`);
   }
   assert(new Set(list.map((i) => i.order)).size === list.length, 'orderが重複している');
});

test('reorder: 自身を除いた位置で動かす', () => {
   const list = [item('a', 1), item('b', 2), item('c', 3)];
   equal(ids(apply(list, reorder(list, 'a', 2))), ['b', 'c', 'a']);
   equal(ids(apply(list, reorder(list, 'c', 0))), ['c', 'a', 'b']);
   equal(ids(apply(list, reorder(list, 'b', 1))), ['a', 'b', 'c']);
});
