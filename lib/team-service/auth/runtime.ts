import { getDb } from '../../db.ts';
import { BoundedKdfScheduler } from './passwords.ts';
import { createTeamAuthService, type TeamAuthService } from './service.ts';

const SERVICE_KEY = Symbol.for('creative-studio.team-auth-service');
const KDF_KEY = Symbol.for('creative-studio.team-auth-kdf');

function sharedKdf(): BoundedKdfScheduler {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  if (!(globals[KDF_KEY] instanceof BoundedKdfScheduler)) {
    const configured = Number(process.env.CREATIVE_STUDIO_AUTH_KDF_CONCURRENCY ?? '1');
    const maxConcurrent = Number.isInteger(configured) && configured >= 1 && configured <= 4 ? configured : 1;
    globals[KDF_KEY] = new BoundedKdfScheduler({ maxConcurrent, maxQueue: 32 });
  }
  return globals[KDF_KEY] as BoundedKdfScheduler;
}

export function getTeamAuthService(): TeamAuthService {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  if (!globals[SERVICE_KEY]) {
    globals[SERVICE_KEY] = createTeamAuthService({ db: getDb(), kdf: sharedKdf() });
  }
  return globals[SERVICE_KEY] as TeamAuthService;
}

export function setTeamAuthServiceForTests(service: TeamAuthService | null): void {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  if (service) globals[SERVICE_KEY] = service;
  else delete globals[SERVICE_KEY];
}
