// Read-only, explicitly offline verification of every completed generation.
import path from 'node:path';
import fs from 'node:fs';
import { FilmQueue, hashFile, local, readJson, writeJson, now } from './runtime.mjs';
const [projectArg, reportArg] = process.argv.slice(2);
if (!projectArg) throw new Error('Usage: PROJECT [report.json]');
const project = path.resolve(projectArg), file = local(project, 'review/generation-ledger.json');
if (fs.existsSync(local(project, 'review/generation.lock'))) throw new Error('Stop worker before offline verification');
const before = hashFile(file), ledger = readJson(file), records = Object.values(ledger);
if (records.some(r => r.status !== 'downloaded')) throw new Error('This verifier accepts completed tasks only');
let providerCalls = 0;
const forbidden = () => { providerCalls++; throw new Error('Offline verification forbids provider calls'); };
const q = new FilmQueue({ project, adapter: { submit: forbidden, poll: forbidden, download: forbidden }, legacy: true });
const result = await q.drain(records.map(r => r.job));
const report = { ...result, verifiedAt: now(), providerCalls, ledgerUnchanged: before === hashFile(file),
  legacySizeOnly: records.filter(r => !r.outputHash).length, note: 'Historical outputs without SHA256 can only be checked for existence and recorded size; this does not retroactively prove original input identity.' };
if (reportArg) writeJson(path.resolve(reportArg), report);
console.log(JSON.stringify(report, null, 2));
if (providerCalls || !report.ledgerUnchanged || Object.keys(result.errors).length) process.exitCode = 1;
