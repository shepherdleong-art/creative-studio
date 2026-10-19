import { acquireSchemaUpgradeLock } from '../lib/schema-upgrade/lock.ts';

const lockDatabasePath = process.argv[2];
if (!lockDatabasePath) {
  throw new Error('lock database path is required');
}

const lock = await acquireSchemaUpgradeLock({
  lockDatabasePath,
  timeoutMs: 2_000,
  pollIntervalMs: 10,
});

process.stdout.write('locked\n');
setInterval(() => undefined, 1_000);

process.on('SIGTERM', () => {
  lock.release();
  process.exit(0);
});
