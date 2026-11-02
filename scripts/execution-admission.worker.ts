import fs from 'node:fs';
import Database from 'better-sqlite3';

const [dbPath, actorId, instanceId, fenceText, readyPath, goPath] = process.argv.slice(2);
if (!dbPath || !actorId || !instanceId || !fenceText || !readyPath || !goPath) {
  throw new Error('execution admission worker arguments missing');
}
const fence = Number(fenceText);
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
registerExecutionInstance(db, { instanceId, fence, deploymentId: 'deployment-contention' });
const runtime = createExecutionFacade({
  db,
  deploymentId: 'deployment-contention',
  journal: createExecutionJournal({ deploymentId: 'deployment-contention' }),
  actorAllowed: (id) => id === actorId,
  scopeAllowed: () => true,
  maintenance: () => false,
});
const identity = { instanceId, fence };
await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-contention', signal: new AbortController().signal });
fs.writeFileSync(readyPath, 'ready', 'utf8');
const deadline = Date.now() + 10_000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) throw new Error('timed out waiting for admission barrier');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const result = runtime.facade.admit(identity);
const grantedTaskId = result.kind === 'admitted' ? result.grant.operation.taskId : null;
runtime.closeNewWork();
db.close();
process.stdout.write(JSON.stringify({ kind: result.kind, reasons: result.kind === 'deferred' ? result.reasons : [], grantedTaskId }));
