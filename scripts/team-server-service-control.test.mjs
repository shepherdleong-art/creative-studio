import assert from 'node:assert/strict';
import test from 'node:test';
import { runControlledServiceAction } from './team-server/service-control.mjs';

const config = {
  deploymentId: 'studio-prod',
  releaseRoot: 'C:\\controlled\\release',
  appPort: 3300,
  controlCredentialFile: 'C:\\controlled\\config\\control.json',
  stopTimeoutSeconds: 240,
};
const credential = { schemaVersion: 1, deploymentId: 'studio-prod', token: 'fixture-control-token' };

function dependencies(overrides = {}) {
  const calls = [];
  const state = { instanceId: 'instance-a', pid: 200, children: [201, 202], owned: true, exits: true };
  const fixture = {
    calls,
    state,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/status')) {
        return { ok: true, status: 200, json: async () => ({ deploymentId: 'studio-prod', instanceId: state.instanceId, pid: state.pid, ready: true }) };
      }
      if (url.endsWith('/shutdown')) {
        return { ok: true, status: 200, json: async () => ({ deploymentId: 'studio-prod', instanceId: state.instanceId, stopped: true, pendingTasks: 0 }) };
      }
      throw new Error(`unexpected URL ${url}`);
    },
    process: {
      isOwnedByRoot: async (pid, root) => {
        calls.push({ ownerCheck: pid, root });
        return state.owned && root === config.releaseRoot;
      },
      processTree: async (pid) => {
        calls.push({ tree: pid });
        return [pid, ...state.children];
      },
      waitForExit: async (pid) => {
        calls.push({ wait: pid });
        return state.exits;
      },
      isAlive: async (pid) => {
        calls.push({ alive: pid });
        return !state.exits;
      },
      killTree: async (pid) => {
        calls.push({ kill: pid });
        state.exits = true;
      },
    },
    sleep: async () => {},
    ...overrides,
  };
  return fixture;
}

test('默认 dry-run 不读取网络、不停进程，只返回解析后的停机计划', async () => {
  const fixture = dependencies();
  const result = await runControlledServiceAction({ action: 'stop', config, credential, apply: false }, fixture);
  assert.equal(result.dryRun, true);
  assert.equal(result.applyPerformed, false);
  assert.equal(result.wouldStopDeploymentId, 'studio-prod');
  assert.equal(fixture.calls.length, 0);
});

test('受控 stop 先核验实例和本 release 进程树，gracefulShutdown 后确认全部退出', async () => {
  const fixture = dependencies();
  const result = await runControlledServiceAction({ action: 'stop', config, credential, apply: true }, fixture);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.verifiedExitedPids, [200, 201, 202]);
  assert.equal(fixture.calls.filter((call) => call.url).length, 2);
  const shutdown = fixture.calls.find((call) => call.url?.endsWith('/shutdown'));
  assert.equal(shutdown.options.headers.authorization, 'Bearer fixture-control-token');
  assert.deepEqual(JSON.parse(shutdown.options.body), { instanceId: 'instance-a' });
  assert.equal(fixture.calls.some((call) => call.kill), false);
  assert.equal(fixture.calls.some((call) => /4300|litellm/i.test(call.url ?? '')), false, 'app 不得停止独立 LiteLLM');
});

test('未知 PID、部署或实例不属于本 release 时 fail closed，不发 shutdown、不杀进程', async () => {
  for (const mutate of [
    (state) => { state.owned = false; },
    (state) => { state.instanceId = ''; },
  ]) {
    const fixture = dependencies();
    mutate(fixture.state);
    await assert.rejects(
      runControlledServiceAction({ action: 'stop', config, credential, apply: true }, fixture),
      /归属|实例|PID/,
    );
    assert.equal(fixture.calls.some((call) => call.url?.endsWith('/shutdown')), false);
    assert.equal(fixture.calls.some((call) => call.kill), false);
  }
});

test('超时只终止复核后仍属于 release 的记录树根，并报告残留', async () => {
  const fixture = dependencies();
  fixture.state.exits = false;
  const result = await runControlledServiceAction({ action: 'stop', config, credential, apply: true, forceAfterTimeout: true }, fixture);
  assert.equal(result.forced, true);
  assert.equal(result.stopped, true);
  const kills = fixture.calls.filter((call) => call.kill);
  assert.deepEqual(kills, [{ kill: 200 }]);
  assert.ok(fixture.calls.filter((call) => call.ownerCheck === 200).length >= 2, '超时强制前必须重新核验根 PID');
});

test('超时后出现未记录的新子进程时不得用 /T 扩大终止范围', async () => {
  const fixture = dependencies();
  fixture.state.exits = false;
  let treeReads = 0;
  const originalTree = fixture.process.processTree;
  fixture.process.processTree = async (pid) => {
    treeReads += 1;
    if (treeReads === 1) return originalTree(pid);
    return [pid, 201, 202, 999];
  };
  await assert.rejects(
    runControlledServiceAction({ action: 'stop', config, credential, apply: true, forceAfterTimeout: true }, fixture),
    /进程树|新子进程/,
  );
  assert.equal(fixture.calls.some((call) => call.kill), false);
});

test('status 不只探测端口，返回 SCM 所需的实例与进程树证据', async () => {
  const fixture = dependencies();
  const result = await runControlledServiceAction({ action: 'status', config, credential, apply: false }, fixture);
  assert.equal(result.instanceId, 'instance-a');
  assert.deepEqual(result.processTree, [200, 201, 202]);
  assert.equal(result.ownedByRelease, true);
  assert.equal(result.dryRun, true);
  assert.equal(fixture.calls.some((call) => call.url?.endsWith('/shutdown')), false);
});
