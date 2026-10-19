// タッチの端末での全画面表示(Fullscreen API)。アレンジ画面で、通知バーとナビゲーションバーを隠して高さを確保するために使う。
// インストールしたアプリはマニフェスト(display: fullscreen)で最初から全画面で開くので、これを使うのはブラウザで開いたときだけ。
// Fullscreen API で入ると、そのたびにブラウザが「全画面を終了するには〜」の通知を出すため、自動では入れず、
// アレンジのツールバーのボタンから入る。

/** 全画面にできる端末か(iPhone の Safari は動画以外を全画面にできない)。アプリとして全画面で開いているときは出さない */
export function canFullscreen() {
   return Boolean(document.fullscreenEnabled) && matchMedia('(pointer: coarse)').matches
      && !matchMedia('(display-mode: fullscreen)').matches;
}

export function isFullscreen() {
   return Boolean(document.fullscreenElement);
}

export function enterFullscreen() {
   if (!canFullscreen() || isFullscreen()) return;
   // 断られても(操作の外で呼んだときなど)、そのまま使えるので何もしない
   document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

export function exitFullscreen() {
   if (isFullscreen()) document.exitFullscreen().catch(() => {});
}
