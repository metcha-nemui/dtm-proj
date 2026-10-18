// スマホでの全画面表示(Fullscreen API)。アレンジ画面で、通知バーとナビゲーションバーを隠して高さを確保するために使う。
// ブラウザはタップなどの操作の中でしか全画面を許さないので、画面を開いたときに自動では入れない。
// アレンジのタブを押したとき(projectTabs.js)と、アレンジのツールバーのボタンから入る。

// スマホ(タッチで、縦か横が狭い画面)。グローバルヘッダーを隠す条件(base.css)と揃える
const phone = matchMedia('(pointer: coarse) and (max-width: 720px), (pointer: coarse) and (max-height: 500px)');

/** 全画面にできる端末か(iPhone の Safari は動画以外を全画面にできない) */
export function canFullscreen() {
   return Boolean(document.fullscreenEnabled) && matchMedia('(pointer: coarse)').matches;
}

export function isFullscreen() {
   return Boolean(document.fullscreenElement);
}

export function enterFullscreen() {
   if (!canFullscreen() || isFullscreen()) return;
   // 断られても(操作の外で呼んだときなど)、そのまま使えるので何もしない
   document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

/** スマホなら全画面にする。タップの中で呼ぶ */
export function enterFullscreenOnPhone() {
   if (phone.matches) enterFullscreen();
}

export function exitFullscreen() {
   if (isFullscreen()) document.exitFullscreen().catch(() => {});
}
