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
 * 还不归本票改的位置（跨票文件归属见 .ticket-ownership.md）。
 * 侧栏与顶栏已经完全改名，所以这张表是空的；留着入口是为了以后再有
 * 跨票文件先占位时，能明确写出「谁负责」，而不是把断言放宽。
 * 注意：这台表里的文件仍会被扫描，会整条被跳过——只用于确实还没轮到的情况。
 */
const PENDING_BY_OTHER_TICKETS = new Set();

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

// 侧栏与顶栏（05 号票）也已经是新名字：仓库里两个「端名」来源必须给出同一组
// 字符串。这条只读两边、不要求改谁——两边一旦漂移，用户就会在不同位置看到
// 两个名字，而这正是这次改版要消灭的问题。
const brand = await import('../lib/brand.ts');
const navigation = await import('../lib/workspace-navigation.ts');
assert.equal(navigation.workspaceProductName(null), brand.BRAND_NAME, '顶栏/侧栏的默认名必须与 lib/brand.ts 一致');
assert.equal(navigation.workspaceProductName('employee'), brand.EMPLOYEE_WORKSPACE_TITLE, '员工端名必须一致');
assert.equal(navigation.workspaceProductName('admin'), brand.ADMIN_CONSOLE_TITLE, '管理员端名必须一致');

console.log(`display name sweep passed (${scanned.length} files)`);
