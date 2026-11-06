export type TeamRuntimePhase =
  | 'idle'
  | 'migrating'
  | 'schema_ready'
  | 'registering_recovery'
  | 'recovery_registered'
  | 'recovering'
  | 'recovered'
  | 'starting'
  | 'restore_hold'
  | 'maintenance'
  | 'ready'
  | 'draining'
  | 'stopped'
  | 'failed';

export interface TeamRuntimeState {
  live: true;
  ready: boolean;
  maintenance: boolean;
  phase: TeamRuntimePhase;
  instanceId?: string;
  fence?: number;
  code?: string;
}

const STATE_KEY = Symbol.for('creative-studio.team-runtime-state');

function globalState(): { value: TeamRuntimeState } {
  const scope = globalThis as typeof globalThis & {
    [STATE_KEY]?: { value: TeamRuntimeState };
  };
  if (!scope[STATE_KEY]) {
    scope[STATE_KEY] = {
      value: { live: true, ready: false, maintenance: true, phase: 'idle' },
    };
  }
  return scope[STATE_KEY];
}

export function getTeamRuntimeState(): TeamRuntimeState {
  return { ...globalState().value };
}

export function initializeTeamRuntimeState(identity: { instanceId: string; fence: number }): void {
  globalState().value = {
    live: true,
    ready: false,
    maintenance: true,
    phase: 'idle',
    instanceId: identity.instanceId,
    fence: identity.fence,
  };
}

export function setTeamRuntimePhase(
  phase: TeamRuntimePhase,
  values: Partial<Pick<TeamRuntimeState, 'ready' | 'maintenance' | 'code'>> = {},
): void {
  globalState().value = {
    ...globalState().value,
    ...values,
    phase,
  };
}

export function markTeamRuntimeFailed(code: string): void {
  setTeamRuntimePhase('failed', { ready: false, maintenance: true, code });
}

export function resetTeamRuntimeStateForTests(): void {
  globalState().value = { live: true, ready: false, maintenance: true, phase: 'idle' };
}
