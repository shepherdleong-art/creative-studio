import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('桌面版入口是可执行的双击脚本', () => {
  const stats = fs.statSync(path.join(root, 'start-desktop.command'));

  assert.equal(stats.isFile(), true);
  assert.equal(Boolean(stats.mode & 0o111), true, 'start-desktop.command 必须可执行');
});

test('中文提示里的变量引用都用 ${} 界定', () => {
  // 脚本带 set -u。`$VAR（` 这类写法会让 bash 把全角字符的首字节并进变量名，
  // 触发 unbound variable 而不是打印内容——只有真跑一次才会暴露，所以静态兜住。
  const unbracedBeforeNonAscii = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

  for (const entry of ['start-desktop.command', 'start.command', 'stop.command']) {
    assert.doesNotMatch(read(entry), unbracedBeforeNonAscii, `${entry} 存在未界定的变量引用`);
  }
});

test('桌面版入口启动 Electron 而不是 dev server', () => {
  const startDesktop = read('start-desktop.command');

  assert.match(startDesktop, /node_modules\/\.bin\/electron \./);
  assert.match(startDesktop, /npm run build:desktop/);
  // 桌面壳只消费 production standalone 产物；起 dev server 会让两套服务抢同一个数据库。
  assert.doesNotMatch(startDesktop, /npm run dev/);
  assert.doesNotMatch(startDesktop, /localhost:3000/);
  // 服务端口由桌面壳分配在 loopback 上，入口脚本不得引入任何公网绑定。
  assert.doesNotMatch(startDesktop, /0\.0\.0\.0/);
});

test('桌面版入口锁定私有 Node 运行时并硬断言 Electron 二进制', () => {
  const startDesktop = read('start-desktop.command');

  assert.match(startDesktop, /CREATIVE_STUDIO_NODE="\$\(command -v node\)"/);
  assert.match(startDesktop, /export CREATIVE_STUDIO_NODE/);
  assert.match(startDesktop, /node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron/);
  assert.match(startDesktop, /install\.js/);
  assert.match(startDesktop, /Electron 运行时安装失败/);
});

test('桌面版入口在缺少 standalone 产物时才构建，并支持 --rebuild', () => {
  const startDesktop = read('start-desktop.command');

  assert.match(startDesktop, /\.next\/standalone\/server\.js/);
  assert.match(startDesktop, /\.next\/standalone\/runtime\/server-entry\.js/);
  assert.match(startDesktop, /--rebuild/);
  // 全量构建，而不是只编译桌面壳的 npm run build:desktop。
  assert.match(startDesktop, /if ! npm run build; then/);
});

test('桌面版入口提醒与网页版共用数据库的并发风险', () => {
  const startDesktop = read('start-desktop.command');

  assert.match(startDesktop, /lsof -ti :3000/);
  assert.match(startDesktop, /data\/workbench\.db/);
  assert.match(startDesktop, /stop\.command/);
});

test('桌面版入口与网页版入口同样看管 LiteLLM sidecar', () => {
  const startDesktop = read('start-desktop.command');

  assert.match(startDesktop, /\.venv-litellm\/bin\/litellm/);
  assert.match(startDesktop, /scripts\/start-litellm\.sh/);
  assert.match(startDesktop, /scripts\/stop-litellm\.sh/);
  assert.match(startDesktop, /trap[\s\S]*cleanup/);
  // sidecar 是可选的，启动失败不能阻塞桌面版。
  assert.match(startDesktop, /LiteLLM 启动失败/);
  assert.doesNotMatch(startDesktop, /apiKey|masterKey/);
});

test('桌面壳把 POSIX 信号接到同一条 shutdown 链路', () => {
  const main = read('desktop/main.ts');

  assert.match(main, /'SIGINT', 'SIGTERM', 'SIGHUP'/);
  assert.match(main, /process\.on\(signal, \(\) => \{[\s\S]*?void shutdown\(\);/);
  // 信号路径必须复用 shutdown()，不能绕过 service.stop() 直接 app.exit()，
  // 否则 detached 的私有 Node 服务会变成孤儿继续持有 SQLite。
  assert.doesNotMatch(main, /process\.on\(signal[\s\S]{0,200}?app\.exit\(/);
});
