// Fixed read-only entry. Never accepts module names, commands or executable paths.
import { listTeamBackups } from '../../lib/team-service/maintenance/catalog.ts';
import { listTeamReleaseCandidates } from '../../lib/team-service/maintenance/release-candidates.ts';

process.on('disconnect', () => process.exit(1));
process.once('message', async (request) => {
  try {
    let result;
    if (request.kind === 'backups') {
      result = await listTeamBackups(request.backupRoot, request.deploymentId, request.currentRelease);
    } else if (request.kind === 'candidates') {
      result = await listTeamReleaseCandidates(request.candidateRoot, request.current, request.allowFixtureForTests === true);
    } else throw new Error('Unsupported preview');
    process.send({ ok: true, result }, () => process.exit(0));
  } catch {
    process.send({ ok: false }, () => process.exit(1));
  }
});
