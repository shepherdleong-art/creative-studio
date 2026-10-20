// Windows review protocol. Registry arguments fix the application and data roots;
// an external URI contains only a film identity, never a command, path or origin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const scriptFile = fileURLToPath(import.meta.url);
export const applicationRoot = path.resolve(path.dirname(scriptFile), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const dataIdentity = root => createHash('sha256').update(fs.realpathSync(root)).digest('hex');
export const launchScheme = identity => `creative-studio-film-${identity.slice(0, 16)}`;
const markerPath = root => path.join(root, 'storage/run/reassembled-launcher.json');
const regPath = root => `HKCU\\Software\\Classes\\${launchScheme(dataIdentity(root))}`;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = message => { throw new Error(message); };

export function parseLaunchUri(raw, identity) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s"'<>]/.test(raw)) fail('审片链接格式无效');
  let url; try { url = new URL(raw); } catch { fail('审片链接格式无效'); }
  if (url.href !== raw) fail('审片链接格式无效');
  if (url.protocol !== launchScheme(identity) + ':' || url.hostname !== 'open' || url.username || url.password || url.port || url.hash) fail('审片链接不属于当前数据目录');
  const id = url.pathname.slice(1), entries = [...url.searchParams.entries()];
  if (!validId(id) || entries.length !== 3 || new Set(entries.map(([k]) => k)).size !== 3 || entries.some(([k]) => !['data', 'version', 'token'].includes(k))) fail('审片身份字段无效');
  if (url.searchParams.get('data') !== identity || !/^[a-f0-9]{64}$/.test(url.searchParams.get('token') || '') || !/^[1-9][0-9]{0,8}$/.test(url.searchParams.get('version') || '')) fail('审片数据身份或版本无效');
  return { id, version: Number(url.searchParams.get('version')), token: url.searchParams.get('token') };
}

export async function discoverDesktop(root) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(root, 'storage/run/electron-service.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('桌面状态无法读取，请手动启动并重新连接'); }
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(state.origin || '');
  if (!match || Number(match[1]) > 65535 || !validId(state.instanceId)) fail('桌面状态身份无效，已停止连接');
  let response;
  try { response = await fetch(`${state.origin}/api/reassembled-films/capabilities`, { signal: AbortSignal.timeout(3000) }); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; fail('桌面响应超时或连接中断，请稍后重试；未重复启动'); }
  if (!response.ok) fail('桌面能力查询失败，请手动启动并重新连接');
  const identity = await response.json();
  if (identity.instanceId !== state.instanceId || identity.dataIdentity !== dataIdentity(root) || identity.apiVersion !== 1) fail('桌面实例或数据目录身份不匹配');
  return { ...identity, origin: state.origin };
}

function registryRead(key, value) {
  try {
    // reg.exe emits the machine's active code page, not UTF-8. Read Unicode
    // registry values directly; arguments stay in environment variables.
    const code = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $entry=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:CREATIVE_STUDIO_REGISTRY_KEY); if ($null -eq $entry) { exit 2 }; try { $value=$entry.GetValue($env:CREATIVE_STUDIO_REGISTRY_VALUE,$null); if ($null -eq $value) { exit 2 }; [Console]::Write([string]$value) } finally { $entry.Dispose() }";
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', code], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CREATIVE_STUDIO_REGISTRY_KEY: key.replace(/^HKCU\\/, ''), CREATIVE_STUDIO_REGISTRY_VALUE: value || '' } });
  } catch (error) { if (error.status === 2) return null; throw new Error('无法读取本用户审片协议设置'); }
}
function registryWrite(key, name, value) {
  execFileSync('reg.exe', ['add', key, ...(name ? ['/v', name] : ['/ve']), '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, stdio: 'pipe' });
}
function registryExists(key) {
  try { execFileSync('reg.exe', ['query', key], { windowsHide: true, stdio: 'pipe' }); return true; }
  catch (error) { if (error.status === 1) return false; fail('无法核对本用户审片协议归属'); }
}
function commandFor(root, node) {
  const wrapper = path.join(applicationRoot, 'scripts/reassembled-launch.ps1');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const value of [root, node, wrapper, shell]) if (/["\r\n]/.test(value)) fail('启动路径含不支持的字符');
  if (!fs.existsSync(wrapper) || !fs.existsSync(shell)) fail('缺少本机审片启动组件');
  return `"${shell}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${wrapper}" -NodePath "${node}" -DataRoot "${root}" -Uri "%1"`;
}
export async function registerLauncher(rootArg) {
  if (process.platform !== 'win32') fail('当前审片冷启动接入仅支持 Windows；其他平台请先启动桌面');
  const root = fs.realpathSync(rootArg), identity = await discoverDesktop(root);
  if (!identity?.capabilities?.includes('film-review-launch/1')) fail('请先启动支持审片启动的桌面版本');
  if (!identity.applicationRoot || fs.realpathSync(identity.applicationRoot) !== fs.realpathSync(applicationRoot)) fail('请使用当前桌面所在应用目录的 connect 命令');
  if (!path.isAbsolute(identity.desktopUserData || '') || !fs.existsSync(identity.desktopUserData)) fail('桌面用户目录无效');
  const launcher = path.join(applicationRoot, 'scripts/start-desktop-windows.ps1');
  if (!fs.existsSync(launcher)) fail('应用缺少桌面启动脚本，请重新完整复制应用');
  const node = fs.existsSync(path.join(applicationRoot, 'node-runtime/node.exe')) ? path.join(applicationRoot, 'node-runtime/node.exe') : process.execPath;
  const key = regPath(root), owner = registryRead(key, 'CreativeStudioDataIdentity');
  if (registryExists(key) && owner !== identity.dataIdentity) fail('同名协议已有其他归属，未覆盖现有设置');
  const command = commandFor(root, node);
  registryWrite(key, 'CreativeStudioDataIdentity', identity.dataIdentity);
  registryWrite(key, null, 'URL:Creative Studio film review');
  registryWrite(key, 'URL Protocol', '');
  registryWrite(`${key}\\shell\\open\\command`, null, command);
  if (registryRead(`${key}\\shell\\open\\command`) !== command) fail('审片协议写入核验失败');
  const config = { schemaVersion: 1, scheme: launchScheme(identity.dataIdentity), dataIdentity: identity.dataIdentity, applicationRoot, node, desktopUserData: identity.desktopUserData, portable: fs.existsSync(path.join(applicationRoot, 'portable-manifest.json')) };
  fs.mkdirSync(path.dirname(markerPath(root)), { recursive: true });
  fs.writeFileSync(markerPath(root), JSON.stringify(config, null, 2), { mode: 0o600 });
  return { configured: true, scheme: config.scheme, dataIdentity: config.dataIdentity, applicationRoot };
}
export function unregisterLauncher(rootArg) {
  if (process.platform !== 'win32') fail('仅支持 Windows');
  const root = fs.realpathSync(rootArg), key = regPath(root), identity = dataIdentity(root);
  if (registryRead(key, 'CreativeStudioDataIdentity') !== identity) fail('审片协议归属不同或不存在，未删除');
  execFileSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, stdio: 'pipe' });
  fs.rmSync(markerPath(root), { force: true });
  return { disconnected: true, scheme: launchScheme(identity) };
}

function launchDesktop(root, config) {
  const logDir = path.join(root, 'storage/logs'); fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'reassembled-launch.log'), 'a');
  const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_NODE: config.node, CREATIVE_STUDIO_REVIEW_USER_DATA: config.desktopUserData };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete env[name];
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(applicationRoot, 'scripts/start-desktop-windows.ps1'), '-ReviewLaunch', ...(config.portable ? ['-Portable'] : [])];
  try {
    // Keep the hidden helper alive until its startup wrapper exits: closing
    // the parent console early can terminate PowerShell before sidecar cleanup.
    // Detached hidden PowerShell may exit 0 without executing its command.
    const child = spawn('powershell.exe', args, { cwd: applicationRoot, env, windowsHide: true, stdio: ['ignore', log, log] });
    child.on('error', () => { child.launchError = true; }); return child;
  } finally { fs.closeSync(log); }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function openReview(rootArg, raw, options = {}) {
  const root = fs.realpathSync(rootArg), identity = dataIdentity(root), film = parseLaunchUri(raw, identity);
  const config = JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
  if (config.schemaVersion !== 1 || config.dataIdentity !== identity || config.scheme !== launchScheme(identity) || fs.realpathSync(config.applicationRoot) !== fs.realpathSync(applicationRoot)) fail('审片启动配置已过期，请在当前应用重新 connect');
  const timeout = options.timeout ?? 900000, end = Date.now() + timeout;
  const lockFile = path.join(root, 'storage/run/reassembled-launch.lock');
  const nonce = randomUUID(), lock = JSON.stringify({ pid: process.pid, nonce });
  let held = false, child, desktop;
  const discover = options.discover ?? discoverDesktop;
  try {
    while (Date.now() < end) {
      if (!held) {
        try { fs.writeFileSync(lockFile, lock, { flag: 'wx', mode: 0o600 }); held = true; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let old; try { old = fs.readFileSync(lockFile, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          let previous;
          try { previous = JSON.parse(old); } catch { fail('启动锁异常，请手动核对，未重复启动'); }
          try { if (!processAlive(previous.pid) && fs.readFileSync(lockFile, 'utf8') === old) fs.unlinkSync(lockFile); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (held) {
          desktop = await discover(root); if (desktop) break;
          child = (options.startDesktop ?? launchDesktop)(root, config);
        }
      }
      if (held) { desktop = await discover(root); if (desktop) break; }
      if (held && child && child.exitCode !== null && child.exitCode !== undefined) fail(`桌面启动已退出（代码 ${child.exitCode}），请查看本机启动日志或手动启动工作台`);
      if (child?.launchError) fail('无法启动桌面脚本，请手动启动并重新连接');
      await delay(options.interval ?? 500);
    }
    if (!desktop) fail('桌面尚未就绪，请查看启动日志；未再次提交启动');
    if (desktop.dataIdentity !== identity || !desktop.applicationRoot || fs.realpathSync(desktop.applicationRoot) !== fs.realpathSync(applicationRoot)) fail('运行中的桌面不属于该应用和数据目录');
    const requestId = randomUUID();
    const query = new URLSearchParams({ instance: desktop.instanceId, data: identity, version: String(film.version), token: film.token, navigationRequest: requestId });
    const response = await fetch(`${desktop.origin}/api/reassembled-films/${film.id}/open?${query}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})); fail(error.message || error.error || '成片定位失败，请在工作台核对交付身份');
    }
    const receiptFile = path.join(root, 'storage/run/reassembled-navigation-results', `${requestId}.json`);
    let confirmed = false;
    const navigationDeadline = Math.min(end, Date.now() + 30000);
    while (Date.now() < navigationDeadline) {
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt) {
        fs.unlinkSync(receiptFile);
        if (receipt.requestId !== requestId || receipt.instanceId !== desktop.instanceId || receipt.bindingId !== film.id || receipt.deliveryVersion !== film.version || receipt.ok !== true) fail('桌面未能加载目标成片，请在工作台重试');
        confirmed = true; break;
      }
      await delay(options.interval ?? 100);
    }
    if (!confirmed) fail('桌面尚未确认加载目标成片，请查看工作台；未重复提交启动');
    const status = { ok: true, navigationConfirmed: true, bindingId: film.id, version: film.version, instanceId: desktop.instanceId, at: new Date().toISOString() };
    fs.writeFileSync(path.join(root, 'storage/run/reassembled-launch-status.json'), JSON.stringify(status));
    return status;
  } finally {
    if (held) { try { if (fs.readFileSync(lockFile, 'utf8') === lock) fs.unlinkSync(lockFile); } catch { /* preserve any replacement lock; cleanup must not mask the original result */ } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  const [command, root, uri, ...extra] = process.argv.slice(2);
  try {
    if (!root || extra.length || !['register', 'unregister', 'open'].includes(command) || (command === 'open' ? !uri : uri !== undefined)) fail('审片启动参数无效');
    const result = command === 'register' ? await registerLauncher(root) : command === 'unregister' ? unregisterLauncher(root) : await openReview(root, uri);
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never echo raw argv or a review URI/token into logs or dialogs.
    const message = error instanceof Error ? error.message : '审片启动失败'; console.error(message); process.exitCode = 1;
    if (command === 'open' && root) {
      try {
        const localRoot = fs.realpathSync(root);
        if (fs.existsSync(markerPath(localRoot))) {
          const directory = path.join(localRoot, 'storage/logs'); fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'reassembled-launch-error.json'), JSON.stringify({ at: new Date().toISOString(), message }));
        }
      } catch { /* An invalid/missing local configuration cannot receive a diagnostic. */ }
    }
    if (command === 'open' && process.platform === 'win32' && process.env.CREATIVE_STUDIO_LAUNCH_NO_DIALOG !== '1') {
      const code = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:CREATIVE_STUDIO_LAUNCH_ERROR, 'Creative Studio') | Out-Null";
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', code], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CREATIVE_STUDIO_LAUNCH_ERROR: message } }); child.on('error', () => {}); child.unref();
    }
  }
}
