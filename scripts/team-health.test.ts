import assert from 'node:assert/strict';

const {
  initializeTeamRuntimeState,
  markTeamRuntimeFailed,
  resetTeamRuntimeStateForTests,
  setTeamRuntimePhase,
} = await import('../lib/team-service/runtime/state.ts');
const { GET: live } = await import('../app/api/team/health/live/route.ts');
const { GET: ready } = await import('../app/api/team/health/ready/route.ts');

try {
  resetTeamRuntimeStateForTests();
  const liveResponse = live();
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await liveResponse.json(), { live: true });

  const notReady = ready();
  assert.equal(notReady.status, 503);
  assert.equal(notReady.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await notReady.json(), {
    ready: false,
    maintenance: true,
    phase: 'idle',
  });

  initializeTeamRuntimeState({ instanceId: 'health-instance', fence: 1 });
  markTeamRuntimeFailed('identity_unavailable');
  assert.equal(live().status, 200, '业务不可用时仍须保留进程活性探测');
  const failedReadiness = ready();
  assert.equal(failedReadiness.status, 503);
  assert.deepEqual(await failedReadiness.json(), {
    ready: false,
    maintenance: true,
    phase: 'failed',
  }, '公共 readiness 不暴露内部错误码或实例诊断');

  initializeTeamRuntimeState({ instanceId: 'health-instance', fence: 1 });
  setTeamRuntimePhase('ready', { ready: true, maintenance: false });
  const readyResponse = ready();
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ready: true,
    maintenance: false,
    phase: 'ready',
  });

  console.log('team health tests passed');
} finally {
  resetTeamRuntimeStateForTests();
}
