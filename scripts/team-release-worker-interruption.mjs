import fs from 'node:fs';
import { runMaintenanceWorker } from '../lib/team-service/maintenance/worker.ts';

const [configPath, mode] = process.argv.slice(2);
await runMaintenanceWorker({
  configPath, once: true,
  makeBackup: async () => { throw new Error('not a backup'); },
  executeRelease: async ({ job }) => {
    if (mode === 'stop') {
      fs.writeFileSync(process.argv[4], job.id);
      await new Promise(() => {});
    }
    return { status: 'completed', maintenance: false, sameJobId: job.id };
  },
});
