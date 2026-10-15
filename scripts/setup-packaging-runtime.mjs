// Explicit developer setup; the running application never downloads dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const packaging = path.join(root, 'packaging');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请通过 npm run setup:packaging 运行');
const result = spawnSync(process.execPath, [npmCli, 'ci', '--prefix', packaging, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('包装依赖安装失败');
const { install, Browser } = await import(pathToFileURL(path.join(packaging, 'node_modules/@puppeteer/browsers/lib/main.js')).href);
const cacheDir = path.join(root, '.cache', 'packaging-browser');
const browser = await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId: '152.0.7977.30', cacheDir });
const target = path.join(packaging, 'runtime', 'chrome-headless-shell');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.dirname(browser.executablePath), target, { recursive: true });
const hyperframesVersion = JSON.parse(fs.readFileSync(path.join(packaging, 'node_modules/hyperframes/package.json'), 'utf8')).version;
console.log(`包装运行时已安装（HyperFrames ${hyperframesVersion} / Chrome 152.0.7977.30）`);
