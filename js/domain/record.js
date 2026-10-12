// 全レコード共通の id / createdAt / updatedAt の扱い。

const now = () => new Date().toISOString();

/** id とタイムスタンプを付けて新しいレコードを作る。 */
export function newRecord(fields) {
   const at = now();
   return { id: crypto.randomUUID(), ...fields, createdAt: at, updatedAt: at };
}

/** patch を当てて updatedAt を進めたコピーを返す。元のレコードは変更しない。 */
export function touch(record, patch = {}) {
   return { ...record, ...patch, updatedAt: now() };
}
