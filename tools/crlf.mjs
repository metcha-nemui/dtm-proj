// Claude Code の hook(PostToolUse の Write / Edit)から呼ぶ。書いたファイルの改行を CRLF に揃える。
// ツールで書いたファイルは LF になりやすく、コミット前に毎回確かめていた手間を省くため。
// 標準入力に hook の JSON を受け取る。リポジトリの外と、テキスト以外のファイルには触らない。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.md', '.json', '.sql', '.svg', '.webmanifest']);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const file = path.resolve(JSON.parse(input).tool_input?.file_path ?? '');
const inside = !path.relative(ROOT, file).startsWith('..') && !path.isAbsolute(path.relative(ROOT, file));
if (inside && TEXT.has(path.extname(file).toLowerCase()) && fs.existsSync(file)) {
   const text = fs.readFileSync(file, 'utf8');
   const crlf = text.replace(/\r?\n/g, '\r\n');
   if (crlf !== text) fs.writeFileSync(file, crlf);
}
