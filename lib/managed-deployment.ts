/** Environment flag used only by the installed Windows managed deployment. */
export const MANAGED_DEPLOYMENT_ENV = 'CREATIVE_STUDIO_MANAGED_DEPLOYMENT' as const;

export type ManagedWorkbenchPhase =
  | 'unrestricted'
  | 'unconfigured'
  | 'starting'
  | 'ready'
  | 'failed';

/**
 * Return true only for the exact managed-deployment signal.
 *
 * The default is intentionally process.env, but callers (and tests) can pass
 * an isolated environment object. No provisioning state is consulted here.
 */
export function isManagedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_DEPLOYMENT_ENV] === '1';
}
