import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_JSON = new Set(['network-plan.json', 'resolved-services.json']);

function fail(message) {
  throw new Error(message);
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0%]/.test(value) || !path.win32.isAbsolute(value)) {
    fail(`${label} 必须是不含环境变量展开符的绝对路径`);
  }
  const resolved = path.resolve(value);
  if (path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) fail(`${label} 不得是磁盘根目录`);
  return resolved;
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSeparateRoots(config) {
  const roots = ['deploymentRoot', 'dataRoot', 'backupRoot'].map((key) => ({ key, value: config[key] }));
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (inside(roots[left].value, roots[right].value) || inside(roots[right].value, roots[left].value)) {
        fail(`部署根、数据根与备份根不得重叠：${roots[left].key}/${roots[right].key}`);
      }
    }
  }
  for (const root of roots) {
    for (const oldRoot of config.oldRoots) {
      if (inside(root.value, oldRoot) || inside(oldRoot, root.value)) fail(`新旧目录不得重叠：${root.key}`);
    }
  }
}

function assertNoLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (process.platform === 'win32' && stat.isDirectory()
        && Boolean(stat.mode & 0o400000) && fs.realpathSync(current) !== current)) {
        fail(`配置路径不得包含目录链接：${current}`);
      }
      if (process.platform === 'win32') {
        try {
          const real = fs.realpathSync(current);
          if (real !== current) fail(`配置路径不得包含目录链接：${current}`);
        } catch (error) {
          if (error.message?.includes('目录链接')) throw error;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) fail(`${label} 必须是 1–65535`);
  return value;
}

function safeId(value, label, max = 128) {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${max - 1}}$`).test(value)) {
    fail(`${label} 只能包含字母、数字、点、下划线和连字符`);
  }
  return value;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function quoteArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function caddyToken(value) {
  const text = String(value);
  return /[\s#]/.test(text) ? JSON.stringify(text) : text;
}

function serviceAccount(value) {
  if (typeof value !== 'string') fail('服务账号必须是 gMSA 或受限内置账号');
  if (/^NT AUTHORITY\\(?:NetworkService|LocalService)$/i.test(value)) {
    const [domain, user] = value.split('\\');
    return { domain, user };
  }
  const match = /^([^\\\r\n]+)\\([^\\\r\n]+\$)$/.exec(value);
  if (!match) fail('服务账号必须使用无口令 gMSA（DOMAIN\\name$）或 NT AUTHORITY 受限账号');
  return { domain: match[1], user: match[2] };
}

function accountXml(account) {
  return `  <serviceaccount>\n    <domain>${xml(account.domain)}</domain>\n    <user>${xml(account.user)}</user>\n    <allowservicelogon>true</allowservicelogon>\n  </serviceaccount>`;
}

function loggingXml(logPath) {
  return `  <logpath>${xml(logPath)}</logpath>\n  <log mode="roll-by-size">\n    <sizeThreshold>10240</sizeThreshold>\n    <keepFiles>8</keepFiles>\n  </log>`;
}

function failureXml() {
  return '  <onfailure action="restart" delay="10 sec"/>\n  <onfailure action="restart" delay="30 sec"/>\n  <onfailure action="restart" delay="60 sec"/>\n  <resetfailure>1 hour</resetfailure>';
}

function serviceXml({ id, description, executable, startArguments, workingDirectory, account, logPath, env = [], depend, stop }) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<service>',
    `  <id>${xml(id)}</id>`,
    `  <name>${xml(id)}</name>`,
    `  <description>${xml(description)}</description>`,
    `  <executable>${xml(executable)}</executable>`,
    `  <startarguments>${xml(startArguments)}</startarguments>`,
    `  <workingdirectory>${xml(workingDirectory)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    '  <delayedAutoStart/>',
    '  <stoptimeout>180 sec</stoptimeout>',
    '  <waithint>60 sec</waithint>',
    '  <sleeptime>2 sec</sleeptime>',
  ];
  if (stop) {
    lines.push(`  <stopexecutable>${xml(stop.executable)}</stopexecutable>`);
    lines.push(`  <stoparguments>${xml(stop.arguments)}</stoparguments>`);
    lines.push('  <stopparentprocessfirst>false</stopparentprocessfirst>');
  }
  if (depend) lines.push(`  <depend>${xml(depend)}</depend>`);
  lines.push(accountXml(account), loggingXml(logPath), failureXml());
  for (const [name, value] of Object.entries(env)) lines.push(`  <env name="${xml(name)}" value="${xml(value)}"/>`);
  lines.push('</service>', '');
  return lines.join('\r\n');
}

function normalizeNetwork(value) {
  if (typeof value !== 'string') fail('allowedNetworks 必须是明确 CIDR');
  const [address, prefix, ...rest] = value.split('/');
  const family = net.isIP(address);
  if (!family || rest.length || !/^\d+$/.test(prefix ?? '')) fail(`无效内网 CIDR：${value}`);
  const bits = family === 4 ? 32 : 128;
  if (Number(prefix) < 1 || Number(prefix) > bits) fail('不得使用默认路由或过宽防火墙范围');
  return `${address}/${Number(prefix)}`;
}

const DEFAULT_MODULES = Object.freeze({
  batch: true,
  scriptStudio: true,
  canvas: true,
  scriptStudioScheduler: true,
});

function normalizeModules(value) {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    fail('modules 必须是显式模块开关对象');
  }
  const input = value ?? {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_MODULES)) {
    if (input[key] === undefined) {
      result[key] = fallback;
    } else if (typeof input[key] === 'boolean') {
      result[key] = input[key];
    } else {
      fail(`modules.${key} 必须是布尔值`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_MODULES, key)) fail(`未知模块开关：modules.${key}`);
  }
  return result;
}

function normalizeClientUpdateUrl(value, origin) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') fail('clientUpdateManifestUrl 必须是同源路径或绝对 URL');
  const candidate = value.startsWith('/') ? new URL(value, origin) : new URL(value);
  if (candidate.origin !== origin.origin || candidate.username || candidate.password || candidate.search || candidate.hash) {
    fail('clientUpdateManifestUrl 必须与受信 origin 同源，且不含凭据、查询或片段');
  }
  if (!candidate.pathname.startsWith('/client-updates/')) {
    fail('clientUpdateManifestUrl 只能指向受控的 /client-updates/ 静态目录');
  }
  return candidate.toString();
}

export function resolveDeploymentConfig(input) {
  if (!input || input.schemaVersion !== 1) fail('部署配置 schemaVersion 必须为 1');
  const config = {
    ...input,
    deploymentId: safeId(input.deploymentId, 'deploymentId'),
    releaseId: safeId(input.releaseId, 'releaseId'),
    deploymentRoot: absolute(input.deploymentRoot, 'deploymentRoot'),
    dataRoot: absolute(input.dataRoot, 'dataRoot'),
    backupRoot: absolute(input.backupRoot, 'backupRoot'),
    oldRoots: Array.isArray(input.oldRoots) ? input.oldRoots.map((root) => absolute(root, 'oldRoots')) : fail('oldRoots 必须是数组'),
    appHost: input.appHost ?? '127.0.0.1',
    liteLLMHost: input.liteLLMHost ?? '127.0.0.1',
    appPort: port(input.appPort, 'appPort'),
    liteLLMPort: port(input.liteLLMPort, 'liteLLMPort'),
    servicePrefix: safeId(input.servicePrefix, 'servicePrefix', 48).replaceAll(/[._-]/g, ''),
    enableLiteLLM: input.enableLiteLLM === true,
    maxRequestBytes: input.maxRequestBytes ?? 64 * 1024 * 1024,
    stopTimeoutSeconds: input.stopTimeoutSeconds ?? 240,
  };
  if (config.appHost !== '127.0.0.1' || config.liteLLMHost !== '127.0.0.1') fail('app/LiteLLM 必须绑定 127.0.0.1 回环地址');
  if (config.appPort === config.liteLLMPort) fail('app/LiteLLM 端口不得相同');
  if (!Number.isInteger(config.maxRequestBytes) || config.maxRequestBytes < 1024 * 1024 || config.maxRequestBytes > 256 * 1024 * 1024) {
    fail('maxRequestBytes 必须在 1–256 MiB 之间');
  }
  if (!Number.isInteger(config.stopTimeoutSeconds) || config.stopTimeoutSeconds < 240 || config.stopTimeoutSeconds > 900) {
    fail('stopTimeoutSeconds 必须覆盖 120 秒应用排空及进程树退出预算（240–900 秒）');
  }
  let origin;
  try { origin = new URL(input.origin); } catch { fail('origin 必须是精确 HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.username || origin.password) fail('origin 必须是无凭据、无路径的精确 HTTPS origin');
  config.origin = origin.origin;
  config.entryPort = Number(origin.port || 443);
  config.serviceAccount = serviceAccount(input.serviceAccount);
  if (!input.certificate || typeof input.certificate !== 'object') fail('必须显式提供受信证书路径；本工具不伪造证书');
  config.certificate = {
    certPath: absolute(input.certificate.certPath, 'certificate.certPath'),
    keyPath: absolute(input.certificate.keyPath, 'certificate.keyPath'),
  };
  config.allowedNetworks = Array.isArray(input.allowedNetworks) ? [...new Set(input.allowedNetworks.map(normalizeNetwork))] : fail('allowedNetworks 必须是数组');
  config.modules = normalizeModules(input.modules);
  assertSeparateRoots(config);
  config.releaseRoot = path.join(config.deploymentRoot, 'releases', config.releaseId);
  config.clientUpdateManifestUrl = normalizeClientUpdateUrl(input.clientUpdateManifestUrl, origin);
  // releaseId 必须与包内 manifest 一致，避免目录名、配置和实际发布身份三者漂移。
  const manifestPath = path.join(config.releaseRoot, 'release-manifest.json');
  if (fs.existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      fail('release manifest 无法解析，拒绝生成部署配置');
    }
    if (manifest.releaseId !== config.releaseId) {
      fail(`releaseId 与 manifest 不一致：配置 ${config.releaseId}，manifest ${String(manifest.releaseId)}`);
    }
    if (typeof manifest.sourceCommit === 'string' && manifest.sourceCommit.trim()) {
      config.sourceCommit = manifest.sourceCommit;
    }
  }
  config.serviceRoot = path.join(config.deploymentRoot, 'service');
  config.configRoot = path.join(config.deploymentRoot, 'config');
  config.clientUpdatesRoot = path.join(config.deploymentRoot, 'client-updates');
  config.controlCredentialFile = path.join(config.configRoot, 'control-credential.json');
  config.services = [
    { role: 'caddy', id: `${config.servicePrefix}Caddy` },
    { role: 'app', id: `${config.servicePrefix}App` },
    ...(config.enableLiteLLM ? [{ role: 'litellm', id: `${config.servicePrefix}LiteLLM` }] : []),
  ];
  if (new Set(config.services.map((service) => service.id.toLowerCase())).size !== config.services.length) fail('服务名不得重复');
  config.winswExecutable = path.join(config.releaseRoot, 'tools', 'winsw', 'WinSW.exe');
  config.nodeExecutable = path.join(config.releaseRoot, 'runtimes', 'node', 'node.exe');
  config.pythonExecutable = path.join(config.releaseRoot, 'runtimes', 'python', 'python.exe');
  config.caddyExecutable = path.join(config.releaseRoot, 'tools', 'caddy', 'caddy.exe');
  config.services = config.services.map((service) => ({
    ...service,
    wrapperExecutable: path.join(config.serviceRoot, `${service.id}.exe`),
    definition: path.join(config.serviceRoot, `${service.id}.xml`),
  }));
  return config;
}

function generate(config) {
  const appRoot = path.join(config.releaseRoot, 'app');
  const nodeExe = path.join(config.releaseRoot, 'runtimes', 'node', 'node.exe');
  const pythonExe = path.join(config.releaseRoot, 'runtimes', 'python', 'python.exe');
  const caddyExe = path.join(config.releaseRoot, 'tools', 'caddy', 'caddy.exe');
  const winswExe = path.join(config.releaseRoot, 'tools', 'winsw', 'WinSW.exe');
  const appEntry = path.join(appRoot, 'runtime', 'team-server-entry.cjs');
  const controlHelper = path.join(config.serviceRoot, 'service-control.mjs');
  const appEnvPath = path.join(config.serviceRoot, 'app.env');
  const caddyfile = path.join(config.serviceRoot, 'Caddyfile');
  const liteConfig = path.join(config.configRoot, 'litellm', 'config.yaml');
  const liteEntry = path.join(appRoot, 'runtime', 'start-litellm-proxy.py');
  const logs = path.join(config.dataRoot, 'storage', 'logs', 'services');
  const appEnv = {
    NODE_ENV: 'production',
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: config.dataRoot,
    CREATIVE_STUDIO_PORT: String(config.appPort),
    CREATIVE_STUDIO_DEPLOYMENT_ID: config.deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: config.origin,
    CREATIVE_STUDIO_SERVER_ROOT: appRoot,
    CREATIVE_STUDIO_APPLICATION_ROOT: appRoot,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: config.releaseId,
    CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE: config.controlCredentialFile,
    CREATIVE_STUDIO_MODULE_BATCH: config.modules.batch ? '1' : '0',
    CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: config.modules.scriptStudio ? '1' : '0',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: config.modules.scriptStudioScheduler ? '1' : '0',
    CREATIVE_STUDIO_CANVAS_ENABLE: config.modules.canvas ? '1' : '0',
    ...(config.clientUpdateManifestUrl
      ? { CREATIVE_STUDIO_CLIENT_UPDATE_MANIFEST_URL: config.clientUpdateManifestUrl }
      : {}),
  };
  const envText = `${Object.entries(appEnv).map(([key, value]) => `${key}=${value}`).join('\r\n')}\r\n`;
  const services = {
    [`${config.servicePrefix}App.xml`]: serviceXml({
      id: `${config.servicePrefix}App`, description: `Creative Studio application (${config.deploymentId})`,
      executable: nodeExe,
      startArguments: `--env-file=${quoteArgument(appEnvPath)} ${quoteArgument(appEntry)}`,
      workingDirectory: appRoot, account: config.serviceAccount, logPath: logs,
      stop: {
        executable: nodeExe,
        arguments: `${quoteArgument(controlHelper)} stop --config ${quoteArgument(path.join(config.serviceRoot, 'resolved-services.json'))} --credential-file ${quoteArgument(config.controlCredentialFile)} --apply --force-after-timeout`,
      },
    }).replace('<stoptimeout>180 sec</stoptimeout>', `<stoptimeout>${config.stopTimeoutSeconds} sec</stoptimeout>`),
    [`${config.servicePrefix}Caddy.xml`]: serviceXml({
      id: `${config.servicePrefix}Caddy`, description: `Creative Studio HTTPS ingress (${config.deploymentId})`,
      executable: caddyExe, startArguments: `run --config ${quoteArgument(caddyfile)} --adapter caddyfile`,
      workingDirectory: path.dirname(caddyExe), account: config.serviceAccount, logPath: logs,
      depend: `${config.servicePrefix}App`, env: { CREATIVE_STUDIO_DEPLOYMENT_ID: config.deploymentId },
    }),
  };
  if (config.enableLiteLLM) {
    services[`${config.servicePrefix}LiteLLM.xml`] = serviceXml({
      id: `${config.servicePrefix}LiteLLM`, description: `Creative Studio optional LiteLLM (${config.deploymentId})`,
      executable: pythonExe,
      startArguments: `${quoteArgument(liteEntry)} --config ${quoteArgument(liteConfig)} --host 127.0.0.1 --port ${config.liteLLMPort}`,
      workingDirectory: path.dirname(liteConfig), account: config.serviceAccount, logPath: logs,
      env: { PYTHONUTF8: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
  }
  const clientUpdatesRoot = config.clientUpdatesRoot;
  const networkMatcher = config.allowedNetworks.length
    ? `\t@outside not remote_ip ${config.allowedNetworks.join(' ')}\n`
    : '';
  const networkResponse = config.allowedNetworks.length ? 'respond @outside 403' : 'respond 403';
  const caddyConfig = `# Generated for ${config.deploymentId}; operations remain loopback-only.
{
	admin 127.0.0.1:2019
	auto_https disable_redirects
}
${config.origin} {
	tls ${caddyToken(config.certificate.certPath)} ${caddyToken(config.certificate.keyPath)}
${networkMatcher}	route {
		${networkResponse}
		request_body {
			max_size ${config.maxRequestBytes}
		}
		handle /api/team/operations/* {
			respond 404
		}
		handle /api/shutdown {
			respond 404
		}
		handle /api/desktop/* {
			respond 404
		}
		handle /client-updates {
			respond 404
		}
		handle_path /client-updates/* {
			root * ${caddyToken(clientUpdatesRoot)}
			file_server {
				hide .*
			}
			header Cache-Control "no-store"
		}
		handle {
			reverse_proxy 127.0.0.1:${config.appPort} {
				flush_interval -1
			}
		}
	}
}
`;
  const resolved = {
    schemaVersion: 1,
    dryRun: true,
    applyPerformed: false,
    deploymentId: config.deploymentId,
    releaseId: config.releaseId,
    deploymentRoot: config.deploymentRoot,
    dataRoot: config.dataRoot,
    backupRoot: config.backupRoot,
    oldRoots: config.oldRoots,
    origin: config.origin,
    appPort: config.appPort,
    liteLLMPort: config.liteLLMPort,
    entryPort: config.entryPort,
    serviceAccount: `${config.serviceAccount.domain}\\${config.serviceAccount.user}`,
    controlCredentialFile: config.controlCredentialFile,
    releaseRoot: config.releaseRoot,
    sourceCommit: config.sourceCommit ?? null,
    modules: config.modules,
    clientUpdateManifestUrl: config.clientUpdateManifestUrl ?? null,
    clientUpdatesRoot,
    serviceRoot: config.serviceRoot,
    stopTimeoutSeconds: config.stopTimeoutSeconds,
    winswExecutable: winswExe,
    nodeExecutable: nodeExe,
    services: config.services.map((service) => ({ ...service, wrapperExecutable: path.join(config.serviceRoot, `${service.id}.exe`), definition: path.join(config.serviceRoot, `${service.id}.xml`) })),
  };
  const network = {
    schemaVersion: 1,
    applyPerformed: false,
    httpsOnly: true,
    origin: config.origin,
    entryPort: config.entryPort,
    allowedNetworks: config.allowedNetworks,
    loopbackOnlyPorts: [config.appPort, config.liteLLMPort],
    certificate: config.certificate,
    note: 'Configuration only. Certificate trust, SCM and firewall changes require install.ps1 -Apply and on-site evidence.',
  };
  return {
    files: {
      ...services,
      'Caddyfile': caddyConfig,
      'app.env': envText,
      'litellm.env': 'PYTHONUTF8=1\r\nLITELLM_LOCAL_MODEL_COST_MAP=True\r\nNO_PROXY=127.0.0.1,localhost\r\nno_proxy=127.0.0.1,localhost\r\n',
      'network-plan.json': `${JSON.stringify(network, null, 2)}\n`,
      'resolved-services.json': `${JSON.stringify(resolved, null, 2)}\n`,
    },
    resolved,
  };
}

export function generateDeploymentConfiguration(input, outputDirectory) {
  const config = resolveDeploymentConfig(input);
  const output = path.resolve(outputDirectory);
  if (output.toLowerCase() !== config.serviceRoot.toLowerCase()) fail('配置输出必须是 deploymentRoot/service，禁止越界写入');
  assertNoLinks(config.deploymentRoot);
  assertNoLinks(output);
  const { files, resolved } = generate(config);
  const staging = path.join(config.deploymentRoot, `.service-staging-${process.pid}`);
  if (fs.existsSync(staging)) fail('暂存目录已存在，拒绝清理未知目录');
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [name, content] of Object.entries(files)) {
      if (path.basename(name) !== name) fail('生成文件名越界');
      const target = path.join(staging, name);
      fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    }
    if (!fs.existsSync(output)) {
      fs.renameSync(staging, output);
    } else {
      if (!fs.lstatSync(output).isDirectory() || fs.lstatSync(output).isSymbolicLink()) fail('service 输出必须是普通目录');
      for (const name of Object.keys(files)) fs.copyFileSync(path.join(staging, name), path.join(output, name));
      if (!config.enableLiteLLM) fs.rmSync(path.join(output, `${config.servicePrefix}LiteLLM.xml`), { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
  for (const name of GENERATED_JSON) JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
  return resolved;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configPath = argument('--config');
    const output = argument('--output');
    const resolveOnly = process.argv.includes('--resolve-only');
    if (!configPath || (!output && !resolveOnly)) fail('用法：generate-config.mjs --config <deployment.json> [--output <deploymentRoot/service> | --resolve-only]');
    const input = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8').replace(/^\uFEFF/, ''));
    const resolved = resolveOnly ? resolveDeploymentConfig(input) : generateDeploymentConfiguration(input, output);
    if (resolveOnly) {
      // resolve-only 供 PowerShell 直接调用；账号必须是与服务 XML 一致的 domain\user 字符串。
      resolved.serviceAccount = `${resolved.serviceAccount.domain}\\${resolved.serviceAccount.user}`;
    }
    process.stdout.write(resolveOnly
      ? `${JSON.stringify(resolved)}\n`
      : `${JSON.stringify({ ok: true, dryRun: true, applyPerformed: false, deploymentId: resolved.deploymentId, releaseId: resolved.releaseId, output: path.resolve(output), services: resolved.services.map((service) => service.id), ports: { https: resolved.entryPort, app: resolved.appPort, litellm: resolved.liteLLMPort } })}\n`);
  } catch (error) {
    process.stderr.write(`配置生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
