import assert from 'node:assert/strict';
import { readManualScriptFiles, MANUAL_SCRIPT_FILE_BYTES_MAX } from '../lib/batch-production/manual-script-files.ts';
import { normalizeManualScriptBatch } from '../lib/batch-production/manual-script-import.ts';

const file = (name: string, text: string) => new File([text], name);
const entries = await readManualScriptFiles([
  file('沙发口播.TXT', '\uFEFF柔软坐感。\r\n\r\n适合一家人放松。'),
  file('第二份.md', '这里是另一份口播。'),
]);
assert.deepEqual(entries, [
  { filename: '沙发口播.TXT', title: '沙发口播', bodyText: '柔软坐感。\n\n适合一家人放松。' },
  { filename: '第二份.md', title: '第二份', bodyText: '这里是另一份口播。' },
]);
assert.equal(normalizeManualScriptBatch(entries.map((entry) => ({ ...entry, targetDurationSec: 30 }))).length, 2);
const utf16 = new File([new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])], 'unicode.txt');
assert.equal((await readManualScriptFiles([utf16]))[0].bodyText, '中文');
const gbk = new File([new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])], 'gbk.txt');
assert.equal((await readManualScriptFiles([gbk]))[0].bodyText, '中文');
await assert.rejects(readManualScriptFiles([]), /请选择/);
await assert.rejects(readManualScriptFiles(Array.from({ length: 51 }, () => file('a.txt', '正文'))), /1–50/);
await assert.rejects(readManualScriptFiles([file('a.pdf', '正文')]), /仅支持/);
await assert.rejects(readManualScriptFiles([file('a.txt', ' '.repeat(MANUAL_SCRIPT_FILE_BYTES_MAX + 1))]), /64 KB/);
await assert.rejects(readManualScriptFiles([file('a.txt', '\r\n ')]), /为空/);
await assert.rejects(readManualScriptFiles([file('a.txt', '\u0000正文')]), /纯文本/);
await assert.rejects(readManualScriptFiles(Array.from({ length: 21 }, () => file('a.txt', '文'.repeat(5000)))), /总字符数/);
// 单条字数与正文语义校验沿用服务端规则；文件预览允许用户先修正再提交。
const tooLong = await readManualScriptFiles([file('a.txt', '文'.repeat(5001))]);
assert.throws(() => normalizeManualScriptBatch(tooLong.map((entry) => ({ ...entry, targetDurationSec: 15 }))), /5000/);
console.log('batch manual script files tests passed');
