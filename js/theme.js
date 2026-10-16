// UIテーマ(ライト / ダーク / システムに合わせる)。選んだものはこのブラウザの localStorage に覚えておく。
// 色の切り替えは CSS(tokens.css)が <html data-theme> を見て行う。'system' のときは属性を付けず、
// prefers-color-scheme に任せる。読み込み直後のちらつきを防ぐため、属性は index.html の先頭でも付けている。

// index.html の <head> の script も同じキーを読む。変えるときは両方直す
const THEME_KEY = 'dtm-proj:theme';

export const THEMES = [
   { key: 'system', label: 'システム', icon: 'monitor' },
   { key: 'light', label: 'ライト', icon: 'sun' },
   { key: 'dark', label: 'ダーク', icon: 'moon' },
];

// ヘッダーの背景(--surface)と揃える。index.html の theme-color と同じ値
const THEME_COLORS = { light: '#ffffff', dark: '#1e2129' };

/** @returns {'system'|'light'|'dark'} */
export function loadTheme() {
   try {
      const value = localStorage.getItem(THEME_KEY);
      return THEMES.some((t) => t.key === value) ? value : 'system';
   } catch {
      return 'system'; // localStorage を使えない環境では、システムに合わせる
   }
}

/** テーマを画面に当てて、覚えておく。 */
export function setTheme(theme) {
   try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
   } catch {
      // 保存できなくても、開いている間は効く
   }
   applyTheme(theme);
}

export function applyTheme(theme) {
   const root = document.documentElement;
   if (theme === 'system') delete root.dataset.theme;
   else root.dataset.theme = theme;
   // アドレスバーやPWAのタイトルバーの色。meta は media で出し分けているので、
   // テーマを決めているときは両方を同じ色にし、システムのときは元の色に戻す
   for (const meta of document.querySelectorAll('meta[name="theme-color"][data-scheme]')) {
      meta.content = THEME_COLORS[theme === 'system' ? meta.dataset.scheme : theme];
   }
}
