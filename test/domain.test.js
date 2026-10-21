// ドメインロジックと保存まわりの簡易テスト。test.html をブラウザで開くと実行される。
// Node でも動く: node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"
// テスト本体はモジュールごとのファイルに分けてある。ここで全部を読み込み、まとめて実行する。

import './order.test.js';
import './project.test.js';
import './task.test.js';
import './reference.test.js';
import './schedule.test.js';
import './arrangement.test.js';
import './midi.test.js';
import './audio.test.js';
import './work.test.js';
import './store.test.js';

export { report, run } from './helpers.js';
