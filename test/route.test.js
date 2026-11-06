// URL(ハッシュ)と保存先のモードの対応のテスト。test/domain.test.js から読む。

import { href, parseHash } from '../js/route.js';
import { setRepository } from '../js/state.js';
import { test, equal } from './helpers.js';

test('parseHash: 接頭辞なしはオンライン、#/offline で始まればオフライン', () => {
   equal(parseHash(''), { mode: 'online', path: '/' });
   equal(parseHash('#/'), { mode: 'online', path: '/' });
   equal(parseHash('#/p/abc/arrange'), { mode: 'online', path: '/p/abc/arrange' });
   equal(parseHash('#/offline'), { mode: 'offline', path: '/' });
   equal(parseHash('#/offline/'), { mode: 'offline', path: '/' });
   equal(parseHash('#/offline/p/abc'), { mode: 'offline', path: '/p/abc' });
   equal(parseHash('#/offline/settings'), { mode: 'offline', path: '/settings' });
   // 「offline」で始まるだけの別の名前は、接頭辞とみなさない
   equal(parseHash('#/offlinex'), { mode: 'online', path: '/offlinex' });
});

test('href: 指定がなければ、いま開いている保存先の中のリンクにする', () => {
   equal([href('/', 'online'), href('/p/a', 'online'), href('/', 'offline'), href('/p/a/arrange', 'offline')],
      ['#/', '#/p/a', '#/offline', '#/offline/p/a/arrange']);
   setRepository(null, 'offline');
   equal(href('/settings'), '#/offline/settings');
   setRepository(null, 'online');
   equal(href('/settings'), '#/settings');
   for (const hash of ['#/', '#/offline', '#/offline/p/x', '#/p/x']) {
      const { mode, path } = parseHash(hash);
      equal(href(path, mode), hash);
   }
});
