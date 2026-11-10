// Run under an account that can read the source fonts. Copies bytes only; no OS registration.
// CREATIVE_STUDIO_DATA_ROOT=<server data root> node import-shared-fonts.mjs --source <font directory> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from '../../lib/data-root.ts';

const args = process.argv.slice(2);
const sourceArg = args[args.indexOf('--source') + 1];
if (!args.includes('--source') || !sourceArg || sourceArg.startsWith('--') || !process.env.CREATIVE_STUDIO_DATA_ROOT) {
  throw new Error('Set CREATIVE_STUDIO_DATA_ROOT and supply --source <font directory>; use --apply after reviewing the dry run.');
}
const source = fs.realpathSync(sourceArg);
const target = path.join(dataRoot(), 'storage', 'fonts');
if (source.toLowerCase() === target.toLowerCase()) throw new Error('Source and destination must differ.');
const apply = args.includes('--apply');
const report = { apply, candidates: 0, existing: 0, copied: 0, bytes: 0 };
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(ttf|otf|ttc)$/i.test(entry.name)) continue;
  const bytes = fs.readFileSync(path.join(source, entry.name));
  const tag = bytes.subarray(0, 4).toString('latin1');
  if (bytes.length < 12 || !(bytes.readUInt32BE(0) === 0x00010000 || ['OTTO', 'ttcf', 'true'].includes(tag))) throw new Error(`Invalid font file: ${entry.name}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const destination = path.join(target, `${hash}${path.extname(entry.name).toLowerCase()}`);
  report.candidates++;
  report.bytes += bytes.length;
  if (fs.existsSync(destination)) {
    if (!fs.readFileSync(destination).equals(bytes)) throw new Error('Existing shared font content differs.');
    report.existing++;
  } else if (apply) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    report.copied++;
  }
}
console.log(JSON.stringify(report));
