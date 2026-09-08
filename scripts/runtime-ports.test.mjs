// scripts/runtime-ports.test.mjs
// ports.mjs 单测：真实 loopback 监听测探测与释放等待。node 22 直跑，无测试框架。
// 双平台语义：netstat（Windows）/ lsof（unix）都由 findListenerPids 封装，
// 本测试只验证行为契约（能发现、关闭后能等到释放），不绑定具体平台实现。
import assert from 'node:assert/strict';
import net from 'node:net';
import { findListenerPids, waitPortReleased } from './runtime/ports.mjs';

function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const { server, port } = await listen();
let finderResult;
try {
  finderResult = await findListenerPids(port);
  assert.ok(
    finderResult.includes(process.pid),
    `findListenerPids 应发现监听 ${port} 的本进程（PID ${process.pid}），实际: ${JSON.stringify(finderResult)}`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// 关闭后轮询应很快观察到释放（1000ms 余量远大于 500ms 轮询间隔）。
assert.equal(
  await waitPortReleased(port, 8_000),
  true,
  '关闭监听后 waitPortReleased 应返回 true',
);

// 合理参数下的边界：非监听端口返回空数组（不抛错）。
assert.deepEqual(await findListenerPids(1), []);

console.log('runtime ports test passed');
