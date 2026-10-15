// モーダルダイアログ(<dialog> 要素)。確認ダイアログ、簡単な入力フォーム、見るだけのダイアログ。

import { h } from './dom.js';

// build(close) で中身を作る。close(value) で閉じると、その値で Promise が解決する。
// Esc や背景クリックで閉じたときは null。
function showDialog(build) {
   return new Promise((resolve) => {
      let result = null;
      const dialog = h('dialog', { class: 'dialog' });
      const close = (value) => {
         result = value;
         dialog.close();
      };
      dialog.append(build(close));
      dialog.addEventListener('close', () => {
         dialog.remove();
         resolve(result);
      });
      // 背景クリックで閉じる。ダイアログ内で押してから外で離した場合は閉じない
      let pressedBackdrop = false;
      dialog.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === dialog; });
      dialog.addEventListener('click', (e) => {
         if (pressedBackdrop && e.target === dialog) dialog.close();
      });
      document.getElementById('overlay-root').append(dialog);
      dialog.showModal();
   });
}

/**
 * @param {{ title: string, message?: string, okLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
   return showDialog((close) => h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
         e.preventDefault();
         close(true);
      },
   },
   h('h2', { class: 'dialog-title' }, title),
   message && h('p', { class: 'dialog-message' }, message),
   h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'キャンセル'),
      h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, autofocus: true }, okLabel)),
   )).then(Boolean);
}

/**
 * 見るだけのダイアログ。ボタンは「閉じる」だけ。
 * @param {{ title: string, body: Node }} options
 * @returns {Promise<void>}
 */
export function viewDialog({ title, body }) {
   return showDialog((close) => h('div', { class: 'dialog-form' },
      h('h2', { class: 'dialog-title' }, title),
      body,
      h('div', { class: 'dialog-actions' },
         h('button', { type: 'button', class: 'btn', autofocus: true, onclick: () => close(null) }, '閉じる')),
   )).then(() => {});
}

function readValue(field, el) {
   if (field.type === 'checkbox') return el.checked;
   return el.value;
}

function control(field) {
   const common = { name: field.name, id: `field-${field.name}` };
   switch (field.type) {
      case 'textarea':
         return h('textarea', { ...common, class: 'textarea', value: field.value ?? '', placeholder: field.placeholder });
      case 'select':
         return h('select', { ...common, class: 'select' },
            field.options.map((o) => h('option', { value: o.value, selected: o.value === field.value }, o.label)));
      case 'checkbox':
         return h('input', { ...common, type: 'checkbox', checked: Boolean(field.value) });
      default:
         return h('input', {
            ...common, class: 'input', type: field.type ?? 'text', value: field.value ?? '',
            placeholder: field.placeholder, autocomplete: 'off',
         });
   }
}

/**
 * 入力フォームのダイアログ。
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.submitLabel]
 * @param {Array<{ name: string, label: string, type?: 'text'|'number'|'textarea'|'select'|'checkbox',
 *   value?: any, placeholder?: string, required?: boolean,
 *   options?: Array<{ value: string, label: string }> }>} options.fields
 * @returns {Promise<Object|null>} name をキーにした入力値。キャンセルなら null
 */
export function formDialog({ title, message, fields, submitLabel = '保存' }) {
   return showDialog((close) => {
      const controls = new Map(fields.map((f) => [f, control(f)]));
      const onsubmit = (e) => {
         e.preventDefault();
         const values = {};
         for (const [field, el] of controls) {
            values[field.name] = readValue(field, el);
            if (field.required && !String(values[field.name]).trim()) {
               el.focus();
               return;
            }
         }
         close(values);
      };
      return h('form', { class: 'dialog-form', onsubmit },
         h('h2', { class: 'dialog-title' }, title),
         message && h('p', { class: 'dialog-message muted' }, message),
         fields.map((f) => (f.type === 'checkbox'
            ? h('label', { class: 'field field-check' }, controls.get(f), f.label)
            : h('div', { class: 'field' },
               h('label', { class: 'field-label', for: `field-${f.name}` }, f.label),
               controls.get(f)))),
         h('div', { class: 'dialog-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'キャンセル'),
            h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel)));
   });
}
