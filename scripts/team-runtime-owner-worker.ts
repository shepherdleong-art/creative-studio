import { acquireTeamRuntimeOwner } from '../lib/team-service/runtime/owner.ts';

const [root, instanceId, timeoutMs = '250'] = process.argv.slice(2);
if (!root || !instanceId) throw new Error('usage: owner-worker <root> <instanceId> [timeoutMs]');

try {
  const owner = await acquireTeamRuntimeOwner({
    dataRoot: root,
    instanceId,
    timeoutMs: Number(timeoutMs),
    pollIntervalMs: 20,
  });
  process.stdout.write(`${JSON.stringify({
    event: 'acquired',
    instanceId: owner.instanceId,
    fence: owner.fence,
  })}\n`);
  const hold = setInterval(() => undefined, 1_000);
  process.once('SIGTERM', () => {
    clearInterval(hold);
    owner.release();
    process.exit(0);
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
