// node approve-batch.mjs <PROJECT> <list.json>   list: [{id, note}]
import path from 'node:path';
import { approve, readJson } from './runtime.mjs';

const [projectArg, listArg] = process.argv.slice(2);
const project = path.resolve(projectArg);
const list = readJson(path.resolve(listArg));
for (const { id, note } of list) {
  const r = approve(project, id, 'agent', note);
  console.log(`OK ${r.id}`);
}
