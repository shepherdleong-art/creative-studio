import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('桌面版停止入口是可执行的双击脚本', () => {
  const stats = fs.statSync(path.join(root, 'stop-desktop.command'));

  assert.equal(stats.isFile(), true);
  assert.equal(Boolean(stats.mode & 0o111), true, 'stop-desktop.command 必须可执行');
  // 与 start-desktop.command 同样的 set -u 陷阱：$VAR 紧跟全角字符会让
  // bash 把多字节字符并进变量名。
  assert.doesNotMatch(read('stop-desktop.command'), /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/);
});

test('停止脚本先验证身份，再请求优雅关闭', () => {
  const stopDesktop = read('stop-desktop.command');

  // origin 必须是 loopback，且端口经过范围校验。
  assert.match(stopDesktop, /\^http:\\\/\\\/127\\\.0\\\.0\\\.1:/);
  assert.match(stopDesktop, /port < 1 \|\| port > 65535/);
  // 只有健康接口回报的 instanceId 与状态文件一致，才认定这个端口属于本应用。
  assert.match(stopDesktop, /api\/desktop\/health/);
  assert.match(stopDesktop, /verify_instance/);
  // 优雅关闭必须排在任何强制手段之前。
  const gracefulIndex = stopDesktop.indexOf('/api/shutdown');
  const killIndex = stopDesktop.indexOf('kill -KILL');
  assert.ok(gracefulIndex > 0, '缺少 /api/shutdown 优雅关闭请求');
  assert.ok(killIndex > gracefulIndex, '强制终止必须排在优雅关闭之后');
});

test('停止脚本覆盖源码态与安装版两个数据根', () => {
  const stopDesktop = read('stop-desktop.command');

  assert.match(stopDesktop, /CREATIVE_STUDIO_DATA_ROOT/);
  assert.match(stopDesktop, /Library\/Application Support\/CreativeStudio/);
  assert.match(stopDesktop, /storage\/run\/electron-service\.json/);
  assert.match(stopDesktop, /scripts\/stop-litellm\.sh/);
});

test('停止脚本按可执行文件路径匹配，不按端口或进程名误杀', () => {
  const stopDesktop = read('stop-desktop.command');

  assert.match(stopDesktop, /\/Applications\/产品素材工作台\.app\/Contents\/MacOS\/CreativeStudio/);
  assert.match(stopDesktop, /node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron/);
  // 孤儿服务只按工作目录确属本项目 standalone 产物来回收。
  assert.match(stopDesktop, /-d cwd/);
  assert.match(stopDesktop, /\.next\/standalone/);
  // 绝不按监听端口反查 PID 后直接结束进程。
  assert.doesNotMatch(stopDesktop, /lsof -ti/);
});

test('服务意外退出会带着整个应用一起退出', () => {
  const service = read('desktop/service.ts');
  const main = read('desktop/main.ts');

  // 应用内的关闭按钮直接结束 Node 服务；外壳必须跟着退出，
  // 否则只剩一个指向已关闭端口的死窗口。
  assert.match(service, /onUnexpectedExit\?: \(\) => void/);
  assert.match(service, /this\.onUnexpectedExit\?\.\(\)/);
  assert.match(main, /onUnexpectedExit: \(\) => \{[\s\S]*?void shutdown\(\);/);

  // 回调只能挂在"已就绪后意外退出"的分支上：stop() 会先把状态切到
  // stopping，因此正常停机不会重入这条链路。
  // DesktopServiceError 也有 constructor，所以结束位置必须从 handler 起点往后找。
  const exitStart = service.indexOf('private readonly onChildExit');
  assert.ok(exitStart > 0, '找不到 onChildExit');
  const exitHandler = service.slice(exitStart, service.indexOf('constructor(', exitStart));
  const guardIndex = exitHandler.indexOf("this.state !== 'stopping'");
  const callbackIndex = exitHandler.indexOf('this.onUnexpectedExit?.()');
  assert.ok(guardIndex > 0 && callbackIndex > guardIndex, '回调必须在 stopping/stopped 守卫之内');
});

test('关闭确认弹窗在桌面壳里说明应用会自动退出', () => {
  const header = read('components/Header.tsx');

  assert.match(header, /desktopBridge/);
  assert.match(header, /应用会自动退出/);
  assert.match(header, /应用即将退出/);
  // 桌面壳里不能再让用户自己去关窗口。
  assert.match(header, /isDesktop \? '服务已关闭，应用即将退出…' : '服务已关闭，可关闭此窗口'/);
  // 探测必须是 SSR 安全的外部快照，而不是 effect 内同步 setState。
  assert.match(header, /useSyncExternalStore/);
  assert.doesNotMatch(header, /useEffect\(\(\) => \{\s*setIsDesktop/);
});
