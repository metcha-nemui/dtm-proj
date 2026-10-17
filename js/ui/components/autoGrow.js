// 詳細ドロワーのメモ欄を、内容に合わせて伸ばす(タスク詳細とクリップ詳細で使う)。
// 伸ばすのは、欄より下の要素(削除ボタンの行)がドロワーの中に見えたままでいられる高さまで。
// それを超える分は欄の中でスクロールする(手で高さを変えると自動の高さとぶつかるので、CSS で resize を止めている)。

const MIN_HEIGHT = 140; // 内容が少なくても、この高さは取る(.drawer-memo の min-height と同じ)

/**
 * 欄の高さを内容に合わせる。値を入れ替えたとき・上の欄の高さが変わったときにも呼ぶ。
 * 画面の大きさが変わったときは、autoGrow を付けた欄をまとめて合わせ直す。
 * @param {HTMLTextAreaElement} textarea
 */
export function fitTextarea(textarea) {
   const body = textarea.closest('.drawer-body');
   const panel = textarea.closest('.drawer');
   if (!body || !panel) return;
   const scrollTop = body.scrollTop;
   // 一度縮めて、中身の高さを測る
   textarea.style.height = 'auto';
   const borders = textarea.offsetHeight - textarea.clientHeight;
   const content = textarea.scrollHeight + borders;
   const bodyRect = body.getBoundingClientRect();
   const rect = textarea.getBoundingClientRect();
   const top = rect.top - bodyRect.top + body.scrollTop; // 本体の中での欄の上端
   const below = (body.lastElementChild?.getBoundingClientRect().bottom ?? rect.bottom) - rect.bottom
      + parseFloat(getComputedStyle(body).paddingBottom);
   // スマホのボトムシートは中身に合わせて max-height まで伸びるので、その余りも使える高さに数える
   const maxHeight = parseFloat(getComputedStyle(panel).maxHeight);
   const slack = Number.isNaN(maxHeight) ? 0 : Math.max(0, maxHeight - panel.offsetHeight);
   const available = body.clientHeight + slack - top - below;
   textarea.style.height = `${Math.max(MIN_HEIGHT, Math.min(content, available))}px`;
   body.scrollTop = scrollTop;
}

/** 打つたびに高さを合わせる欄にする。値を外から入れたときは、呼び出し側で fitTextarea を呼ぶ */
export function autoGrow(textarea) {
   textarea.dataset.autoGrow = '';
   textarea.addEventListener('input', () => fitTextarea(textarea));
   return textarea;
}

window.addEventListener('resize', () => {
   for (const textarea of document.querySelectorAll('textarea[data-auto-grow]')) fitTextarea(textarea);
});
