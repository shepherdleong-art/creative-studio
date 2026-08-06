/** Next.js Node 运行时启动后恢复批量调度；Edge/浏览器运行时不得加载本地 SQLite。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Provisioned COS/gateway environment must be available before any provider
  // module or the batch scheduler snapshots its runtime configuration.
  const { loadProvisionedRuntimeEnv } = await import('./lib/provisioning/service');
  loadProvisionedRuntimeEnv();
  const { isManagedDeployment } = await import('./lib/managed-deployment');
  if (isManagedDeployment()) {
    const { requestCompanySidecar } = await import('./lib/company-sidecar-control');
    // Do not block Node/UI startup on PowerShell or health convergence. The
    // status endpoint and workbench state machine expose eventual readiness.
    void requestCompanySidecar('start').catch(() => { /* failed state is reported separately */ });
  }
  const { startBatchSchedulerAfterReadiness } = await import('./lib/batch-production/bootstrap');
  void startBatchSchedulerAfterReadiness();
}
