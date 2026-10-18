// 画面の動作確認に使う、ヘッドレス Chrome の操作スクリプト(開発用。アプリからは読まない)。
// 確認のたびに CDP のスクリプトを書き直さずに済むよう、よく使う操作をコマンドにしてある。
// npm の依存を足さないため、Node の組み込みの fetch と WebSocket だけで CDP を話す(Node 22 以降)。
//
//   node tools/browser.mjs start [画面] [幅x高さ]  静的サーバーとヘッドレス Chrome を起動し、ログインせずに使う状態で開く
//                                                  (大きさの既定は 1280x800。スマホ幅は 390x844 など)
//   node tools/browser.mjs open <画面>             画面を移る。読み込み中の例外とエラーのログを出す
//                                                  画面は「#/」を省いたハッシュ(例: p/xxxx/arrange、settings)。
//                                                  「#/p/…」のままだと Git Bash がパスと見なして書き換えるため
//   node tools/browser.mjs eval "<式>"               ページで式を評価して、結果を JSON で出す(await を使える)
//   node tools/browser.mjs click <セレクタ> [2]      要素の中央を本物のマウスでクリックする(2 ならダブルクリック)
//   node tools/browser.mjs drag <x1> <y1> <x2> <y2> [Shift,Ctrl,Alt]   ビューポート座標でドラッグする
//   node tools/browser.mjs touch <x1> <y1> <x2> <y2> [押さえる ms]   指でなぞる(押さえる ms のあいだ止めてから動かす。長押しの確認に使う)
//   node tools/browser.mjs emulate <幅x高さ> "<式>"   スマホ(タッチ・pointer: coarse)の画面にして、式を評価する。
//                                                  CDP の接続を閉じると元に戻るので、確かめたいことは式の中で済ませる
//   node tools/browser.mjs key <キー> [Shift,Ctrl,Alt]   キーを押す(例: "Delete"、"a" Ctrl、" ")
//   node tools/browser.mjs shot <出力.png> [セレクタ]   スクリーンショット。セレクタがあればその要素だけを撮る
//   node tools/browser.mjs stop                      起動したプロセスだけを終了し、プロファイルを消す
//
// - プロファイルは %TEMP%\dtmcs に置く。深い場所だと Cache Storage のパスが 260 文字を超え、
//   Service Worker が本来と違う動きになるため。
// - 新しいプロファイルなので、データは空の IndexedDB(Supabase には触らない)。
//   データを用意するときは eval で操作を呼ぶ: (await import('/js/actions.js')).createProject({ title: 'テスト' })
// - ポートは 8766(サーバー)と 9333(CDP)。ユーザーが 8765 で開いているサーバーとはぶつけない。
// - 終了は起動したときのプロセス ID だけを、子プロセスごと(taskkill /T)止める。プロセス名でまとめて止めない。

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HTTP_PORT = 8766;
const CDP_PORT = 9333;
const ORIGIN = `http://localhost:${HTTP_PORT}/`;
const PROFILE = path.join(process.env.TEMP ?? os.tmpdir(), 'dtmcs');
const STATE = path.join(process.env.TEMP ?? os.tmpdir(), 'dtmcs.json');
const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = [
   'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
   'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
   'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const pageUrl = (route = '') => `${ORIGIN}#/${route.replace(/^#?\/?/, '')}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 10000) {
   const end = Date.now() + timeout;
   while (Date.now() < end) {
      try {
         const value = await check();
         if (value) return value;
      } catch {
         // 起動の途中はつながらないので、時間まで待ち続ける
      }
      await wait(150);
   }
   throw new Error(`${label}が時間内に用意できませんでした`);
}

/** ページのタブにつなぎ、send(method, params) と、イベントの購読を返す */
async function connect() {
   const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
   const page = targets.find((t) => t.type === 'page');
   if (!page) throw new Error('ページが見つかりません(start を先に実行する)');
   const ws = new WebSocket(page.webSocketDebuggerUrl);
   await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP につながりません(start を先に実行する)'));
   });
   let nextId = 1;
   const pending = new Map();
   const listeners = [];
   ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && pending.has(data.id)) {
         const { resolve, reject } = pending.get(data.id);
         pending.delete(data.id);
         if (data.error) reject(new Error(data.error.message));
         else resolve(data.result);
      } else if (data.method) {
         for (const listener of listeners) listener(data);
      }
   };
   const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
   });
   return { send, on: (listener) => listeners.push(listener), close: () => ws.close() };
}

async function evaluate(cdp, expression) {
   const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
   });
   if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
   return result.value;
}

/** 読み込みを待つ間に出た例外とエラーのログを集めて返す */
async function navigate(cdp, url) {
   const problems = [];
   cdp.on(({ method, params }) => {
      if (method === 'Runtime.exceptionThrown') problems.push(`例外: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
         problems.push(`console.error: ${params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
   });
   await cdp.send('Runtime.enable');
   await cdp.send('Page.enable');
   const loaded = new Promise((resolve) => cdp.on(({ method }) => method === 'Page.loadEventFired' && resolve()));
   const { loaderId } = await cdp.send('Page.navigate', { url });
   // ハッシュだけが変わる移動では読み込みが起きず load が来ないので、読み込み直して毎回まっさらな画面にする
   if (!loaderId) await cdp.send('Page.reload');
   await Promise.race([loaded, wait(10000).then(() => problems.push('load が10秒以内に来ませんでした'))]);
   await wait(500); // 描画と、起動時の非同期の読み込みを待つ
   return problems;
}

const MODIFIERS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const modifierBits = (list = '') => list.split(',').filter(Boolean).reduce((bits, name) => bits | (MODIFIERS[name] ?? 0), 0);

async function mouse(cdp, type, x, y, modifiers = 0, clickCount = 1) {
   await cdp.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
}

const commands = {
   async start(route, size = '1280x800') {
      if (!CHROME) throw new Error('Chrome / Edge が見つかりません');
      if (fs.existsSync(STATE)) throw new Error('起動済みです(先に stop を実行する)');
      fs.rmSync(PROFILE, { recursive: true, force: true });
      const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT)], { cwd: ROOT, detached: true, stdio: 'ignore' });
      const chrome = spawn(CHROME, [
         '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
         `--window-size=${size.replace('x', ',')}`, '--mute-audio', '--no-first-run', '--no-default-browser-check', 'about:blank',
      ], { detached: true, stdio: 'ignore' });
      server.unref();
      chrome.unref();
      fs.writeFileSync(STATE, JSON.stringify({ pids: [chrome.pid, server.pid] }));
      await until(() => fetch(ORIGIN).then((r) => r.ok), '静的サーバー');
      await until(() => fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok), 'Chrome');
      const cdp = await connect();
      // ログイン画面を飛ばして、ログインせずに(IndexedDB で)使う状態にする
      await navigate(cdp, ORIGIN);
      await evaluate(cdp, `localStorage.setItem('dtm-proj:session', JSON.stringify({ mode: 'local' }))`);
      const problems = await navigate(cdp, pageUrl(route));
      cdp.close();
      return problems.length ? problems : `起動しました: ${pageUrl(route)}`;
   },

   async open(route) {
      const cdp = await connect();
      const problems = await navigate(cdp, pageUrl(route));
      cdp.close();
      return problems.length ? problems : 'OK';
   },

   async eval(expression) {
      const cdp = await connect();
      try {
         return await evaluate(cdp, expression);
      } finally {
         cdp.close();
      }
   },

   async click(selector, count = '1') {
      const cdp = await connect();
      const rect = await evaluate(cdp, `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
         const r = el.getBoundingClientRect();
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!rect) throw new Error(`見つかりません: ${selector}`);
      await mouse(cdp, 'mouseMoved', rect.x, rect.y);
      // ダブルクリックは、clickCount を 1, 2 と増やして押し離しを続けて送ると dblclick になる
      for (let i = 1; i <= Number(count); i++) {
         await mouse(cdp, 'mousePressed', rect.x, rect.y, 0, i);
         await mouse(cdp, 'mouseReleased', rect.x, rect.y, 0, i);
      }
      await wait(200);
      cdp.close();
      return 'OK';
   },

   async drag(x1, y1, x2, y2, modifiers) {
      const cdp = await connect();
      const bits = modifierBits(modifiers);
      const [ax, ay, bx, by] = [x1, y1, x2, y2].map(Number);
      await mouse(cdp, 'mouseMoved', ax, ay, bits);
      await mouse(cdp, 'mousePressed', ax, ay, bits);
      // しきい値を超えたと判定されるよう、途中の位置も送る
      for (let i = 1; i <= 10; i++) await mouse(cdp, 'mouseMoved', ax + ((bx - ax) * i) / 10, ay + ((by - ay) * i) / 10, bits);
      await mouse(cdp, 'mouseReleased', bx, by, bits);
      await wait(200);
      cdp.close();
      return 'OK';
   },

   async touch(x1, y1, x2, y2, hold = '0') {
      const cdp = await connect();
      const [ax, ay, bx, by] = [x1, y1, x2, y2].map(Number);
      const point = (x, y) => [{ x, y, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(ax, ay) });
      await wait(Number(hold));
      for (let i = 1; i <= 10; i++) {
         await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(ax + ((bx - ax) * i) / 10, ay + ((by - ay) * i) / 10) });
         await wait(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(300);
      cdp.close();
      return 'OK';
   },

   async emulate(size, expression) {
      const cdp = await connect();
      try {
         const [width, height] = size.split('x').map(Number);
         await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
         await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
         await wait(300); // メディアクエリの切り替わりと、描き直しを待つ
         return await evaluate(cdp, expression);
      } finally {
         cdp.close();
      }
   },

   async key(key, modifiers) {
      const cdp = await connect();
      const bits = modifierBits(modifiers);
      const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const text = key.length === 1 && !(bits & (MODIFIERS.Ctrl | MODIFIERS.Alt)) ? key : undefined;
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, text, modifiers: bits });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: bits });
      await wait(200);
      cdp.close();
      return 'OK';
   },

   async shot(out, selector) {
      const cdp = await connect();
      let clip;
      if (selector) {
         clip = await evaluate(cdp, `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
         })()`);
         if (!clip) throw new Error(`見つかりません: ${selector}`);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      cdp.close();
      return `保存しました: ${path.resolve(out)}`;
   },

   async stop() {
      if (!fs.existsSync(STATE)) return '起動していません';
      const { pids } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      for (const pid of pids) {
         try {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
         } catch {
            // すでに終わっているプロセスは無視する
         }
      }
      fs.rmSync(STATE, { force: true });
      // Chrome が終わってファイルを放すまで、少し待ってから消す
      await until(() => {
         fs.rmSync(PROFILE, { recursive: true, force: true });
         return !fs.existsSync(PROFILE);
      }, 'プロファイルの削除', 5000).catch(() => {});
      return '終了しました';
   },
};

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
   console.error('使い方: node tools/browser.mjs start|open|eval|click|drag|touch|emulate|key|shot|stop …(先頭のコメントを参照)');
   process.exit(1);
}
try {
   const result = await commands[name](...args);
   console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
} catch (error) {
   console.error(error.message);
   process.exit(1);
}
