/** Next.js Node 运行时启动后恢复批量调度;Edge/浏览器运行时不得加载本地 SQLite。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startBatchSchedulerAfterReadiness } = await import('./lib/batch-production/bootstrap');
  void startBatchSchedulerAfterReadiness();
}
