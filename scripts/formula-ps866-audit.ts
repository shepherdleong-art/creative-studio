/** Read-only source audit. No database, model request, rendering or source edits. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from '../lib/data-root.ts';
import { readFormulaWorkbook } from '../lib/batch-production/formula/workbook.ts';
import { parseMaterialFilename } from '../lib/batch-production/formula/parse.ts';
import { probeVideoMedia } from '../lib/ffmpeg.ts';

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sourceArgument = value('--source');
if (!sourceArgument) throw new Error('Usage: node scripts/formula-ps866-audit.ts --source <原目录> [--probe]');
const source = fs.realpathSync(sourceArgument), mediaRoot = fs.realpathSync(path.join(source, '预处理'));
if (!fs.statSync(source).isDirectory() || path.relative(source, mediaRoot).startsWith('..')) throw new Error('素材目录必须位于所选源目录内');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(dataRoot(), 'outputs', 'formula-ps866', `audit-${stamp}`);
fs.mkdirSync(output, { recursive: true });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const books = ['PS866素材命名表格.xlsx', 'PS866-300条视频脚本.xlsx'].map(name => ({ name, bytes: fs.readFileSync(path.join(source, name)) }));
const materials = await readFormulaWorkbook(books[0].bytes, 'materials');
const scripts = await readFormulaWorkbook(books[1].bytes, 'scripts');
const definitions = new Map(materials.rows.map(row => [row.logicalCode, row]));
const files: Array<{ relativePath: string; bytes: number; modifiedAt: string; logicalCode: string | null; excludedReason: string | null;
  media?: Awaited<ReturnType<typeof probeVideoMedia>> }> = [];
function visit(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`源目录含链接，须先明确取用范围：${entry.name}`);
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(filename);
    else if (entry.isFile() && /\.(mp4|mov|avi|webm)$/i.test(entry.name)) {
      const stat = fs.statSync(filename);
      files.push({ relativePath: path.relative(mediaRoot, filename).replaceAll('\\', '/'), bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(), ...parseMaterialFilename(entry.name) });
    }
  }
}
visit(mediaRoot); files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }));
if (args.includes('--probe')) {
  let cursor = 0, finished = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++]; file.media = await probeVideoMedia(path.join(mediaRoot, file.relativePath));
      if (++finished % 25 === 0 || finished === files.length) console.log(`已只读核验媒体 ${finished}/${files.length}`);
    }
  }));
}
const candidates = (code: string) => files.filter(file => file.logicalCode === code && !file.excludedReason);
const rows = scripts.rows.map(script => {
  const uniqueCodes = [...new Set(script.codes)];
  const missing = uniqueCodes.filter(code => !candidates(code).length);
  const undefinedCodes = uniqueCodes.filter(code => !definitions.has(code) && !files.some(file => file.logicalCode === code));
  const ambiguous = uniqueCodes.filter(code => candidates(code).length > 1);
  const invalidMedia = uniqueCodes.filter(code => candidates(code).some(file => file.media && (file.media.errorMessage || !file.media.durationUs)));
  return { ...script, missingCodes: missing, undefinedCodes, multipleCandidateCodes: ambiguous, invalidMediaCodes: invalidMedia,
    status: missing.length ? 'missing_material' : invalidMedia.length ? 'media_needs_attention' : 'awaiting_speech_and_ranges',
    message: missing.length ? `缺少原片：${missing.join('、')}` : invalidMedia.length ? `原片媒体核验失败：${invalidMedia.join('、')}`
      : '编号可用；尚需核验实际内容、台词、声音与取用区间，不能计为成功成片',
    slots: script.codes.map((code, index) => ({ position: index + 1, logicalCode: code,
      sourceFiles: candidates(code).map(file => file.relativePath), materialDescription: definitions.get(code)?.fields ?? null })) };
});
const referenced = [...new Set(rows.flatMap(row => row.codes))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const missingCodes = referenced.filter(code => !candidates(code).length);
const summary = { inspectedAt: new Date().toISOString(), source, output, mediaProbed: args.includes('--probe'),
  workbooks: books.map((book, index) => ({ filename: book.name, sha256: hash(book.bytes), rows: index ? scripts.rowCount : materials.rowCount,
    parsedRows: index ? scripts.rows.length : materials.rows.length, issues: index ? scripts.issues : materials.issues })),
  videoFiles: files.length, videoBytes: files.reduce((total, file) => total + file.bytes, 0),
  namedCodes: new Set(files.flatMap(file => file.logicalCode ? [file.logicalCode] : [])).size,
  excludedFiles: files.filter(file => file.excludedReason).map(file => file.relativePath),
  unnamedFiles: files.filter(file => !file.logicalCode).map(file => file.relativePath),
  multipleCandidates: [...new Set(files.flatMap(file => file.logicalCode ? [file.logicalCode] : []))].filter(code => candidates(code).length > 1),
  scripts: rows.length, distinctReferencedCodes: referenced.length, missingCodes,
  withMissingMaterial: rows.filter(row => row.missingCodes.length).length,
  codesAvailable: rows.filter(row => !row.missingCodes.length).length,
  codesAvailableSingleCandidate: rows.filter(row => !row.missingCodes.length && !row.multipleCandidateCodes.length).length,
  mediaFailures: files.filter(file => file.media?.errorMessage || (file.media && !file.media.durationUs)).map(file => file.relativePath),
  platformCounts: Object.fromEntries([...new Set(rows.map(row => row.platform))].map(platform => [platform, rows.filter(row => row.platform === platform).length])),
  mediaFormats: Object.fromEntries([...new Set(files.filter(file => file.media).map(file => `${file.media!.width}x${file.media!.height}@${file.media!.fps}`))]
    .map(format => [format, files.filter(file => file.media && `${file.media.width}x${file.media.height}@${file.media.fps}` === format).length])),
};
const sampleCandidates = [...new Set(rows.map(row => row.platform))].flatMap(platform => rows.filter(row => row.platform === platform
  && !row.missingCodes.length && !row.invalidMediaCodes.length).slice(0, 2));
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'rows.json'), JSON.stringify(rows, null, 2));
fs.writeFileSync(path.join(output, 'files.json'), JSON.stringify(files, null, 2));
fs.writeFileSync(path.join(output, 'sample-candidates.json'), JSON.stringify(sampleCandidates, null, 2));
const csv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
fs.writeFileSync(path.join(output, '逐条状态.csv'), '\uFEFF' + [
  ['脚本号', '平台', '公式', '预估秒数', '状态', '说明', '多候选编号', '实际文案'].map(csv).join(','),
  ...rows.map(row => [row.scriptNumber, row.platform, row.originalFormula, row.targetDurationSec, row.status, row.message,
    row.multipleCandidateCodes.join('、'), row.bodyText].map(csv).join(',')),
].join('\r\n'));
fs.writeFileSync(path.join(output, '核查说明.md'), `# PS866 本次源资料核查\n\n检查时间：${summary.inspectedAt}\n\n`
  + `共 ${rows.length} 条脚本、${files.length} 个视频；${summary.codesAvailable} 条编号可用，${summary.withMissingMaterial} 条缺素材。共有 ${missingCodes.length} 个被引用编号没有正式候选。\n\n`
  + '逐条状态见 CSV/rows.json；这是一轮只读检查，没有生成或审核成片，也没有采用旧替换建议或旧口播资料。编号可用不表示时长、台词或画面已经通过。\n\n'
  + `双表解析问题：${materials.issues.length + scripts.issues.length}；媒体探测：${summary.mediaProbed ? `已检查全部文件，失败 ${summary.mediaFailures.length} 个` : '本轮未执行'}。\n\n`
  + `首批候选：${sampleCandidates.map(row => `${row.scriptNumber}（${row.platform}）`).join('、')}。最终选择须再核对实际画面和台词。\n`);
console.log(JSON.stringify({ ...summary, workbooks: summary.workbooks.map(book => ({ ...book, issues: book.issues.length })),
  samples: sampleCandidates.map(row => ({ number: row.scriptNumber, platform: row.platform, formula: row.originalFormula, text: row.bodyText })) }, null, 2));
