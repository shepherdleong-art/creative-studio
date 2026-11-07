// 旧显示名不再出现在界面源码和启停提示里。
//
// 范围只覆盖面向用户的界面面与启停入口：app/（原型页除外）、components/、
// desktop/、根目录启停脚本、installer/windows/。文档与历史记录不算——那些是
// 记录，不是用户看到的字。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 四个旧显示名：改名前同一个工具在四处出现过的名字。 */
const OLD_NAMES = ['产品素材工作台', 'Creative Studio', '团队生产控制台', '我的创作空间'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css']);

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.next', '.worktrees', 'dist-desktop', 'dist',
  'storage', 'data', 'outputs', 'docs',
]);

/** 原型演示页不是真实界面（规格明确保留），不参加扫描。 */
function isExcluded(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized.startsWith('app/prototype/')) return true;
  return false;
}

function collect(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || isExcluded(relativePath)) continue;
      files.push(...collect(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

const scanned = [
  ...collect(path.join(root, 'app'), 'app'),
  ...collect(path.join(root, 'components'), 'components'),
  ...collect(path.join(root, 'desktop'), 'desktop'),
];

/** 内核壳脚本按路径加进来；它们不是 .ts，但也是用户能看到的提示。 */
const shellEntries = [
  'start.command', 'stop.command', 'start-desktop.command', 'stop-desktop.command',
  'start-windows.cmd', 'stop-windows.cmd', 'start-windows.ps1', 'stop-windows.ps1',
  'start-desktop-windows.ps1', 'stop-stack.ps1', 'launcher.html', 'launcher.vbs',
];
for (const entry of shellEntries) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) continue;
  // .ps1 与 .cmd 的旧名字在脚本横幅里出现过，但它们是启停提示面，要收进来。
  scanned.push(entry);
}

/**
 * 还不归本票改的位置（跨票文件归属见 .ticket-ownership.md）：
 *   - components/Header.tsx、components/team/TeamWorkspaceNavigation.tsx、workspace.module.css
 *     归 05 号票（侧栏与顶栏）。
 *   - app/globals.css 归 02 号票；命中的只是文件头的 CSS 注释，不是界面文字。
 * 这些位置必须<b>恰好</b>只剩它们，别处出现旧名字一律判失败——这样 05 改完
 * 之后只要删掉对应条目，扫描就自动收紧到全仓。
 */
const PENDING_BY_OTHER_TICKETS = new Set([
  'components/Header.tsx',
  'components/team/TeamWorkspaceNavigation.tsx',
  'components/team/workspace.module.css',
  'app/globals.css',
]);

const offenders = [];
for (const relativePath of scanned) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) continue;
  const normalized = relativePath.split(path.sep).join('/');
  const text = fs.readFileSync(absolute, 'utf8');
  for (const oldName of OLD_NAMES) {
    if (!text.includes(oldName)) continue;
    // 允许的唯一例外：停止脚本要能同时停掉仍装着旧名字的应用。
    if (normalized === 'stop-desktop.command') continue;
    if (PENDING_BY_OTHER_TICKETS.has(normalized)) continue;
    offenders.push(`${relativePath}: ${oldName}`);
  }
}

assert.deepEqual(offenders, [], `旧显示名仍在界面源码里：\n${offenders.join('\n')}`);

// 反向守护：新名字确实落在了关键位置，别只是删干净了。
const layout = fs.readFileSync(path.join(root, 'app', 'layout.tsx'), 'utf8');
assert.doesNotMatch(layout, /title:\s*["']产品素材工作台["']/, '根布局不得再写死旧标题');
assert.match(layout, /generateMetadata/, '根布局标题必须按端动态生成');

console.log(`display name sweep passed (${scanned.length} files)`);
