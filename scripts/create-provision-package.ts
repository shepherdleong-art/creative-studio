import fs from 'node:fs';
import path from 'node:path';
import {
  encryptProvisioningPayload,
  MIN_PROVISIONING_PASSWORD_LENGTH,
} from '../lib/provisioning/crypto.ts';
import { MAX_LITE_LLM_CONFIG_BYTES } from '../lib/provisioning/schema.ts';

const MAX_AUTHORING_PROFILE_BYTES = 256 * 1024;

function failUsage(): never {
  console.error('用法：npm run create:provision -- <profile.local.json> <config.yaml> <output.provision>');
  process.exit(2);
}

async function readHiddenLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') {
        cleanup();
        reject(new Error('已取消'));
      } else if (text === '\r' || text === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (text === '\u007f' || text === '\b') {
        value = value.slice(0, -1);
      } else {
        const printable = Array.from(text).filter((character) => {
          const code = character.codePointAt(0) || 0;
          return code >= 0x20 && code !== 0x7f;
        }).join('');
        if (value.length + printable.length <= 1024) value += printable;
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode?.(false);
    };
    process.stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.PROVISION_PASSWORD;
  if (fromEnv) {
    delete process.env.PROVISION_PASSWORD;
    return fromEnv;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请通过一次性环境变量 PROVISION_PASSWORD 或交互式终端提供密码');
  }
  const first = await readHiddenLine(`配置密码（至少 ${MIN_PROVISIONING_PASSWORD_LENGTH} 个字符）：`);
  const second = await readHiddenLine('再次输入配置密码：');
  if (first !== second) throw new Error('两次密码不一致');
  return first;
}

function readBoundedFile(filePath: string, maxBytes: number, label: string): Buffer {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label}不存在、为空或过大`);
  }
  return fs.readFileSync(resolved);
}

async function main(): Promise<void> {
  const profilePath = process.argv[2];
  const configPath = process.argv[3];
  const outputPath = process.argv[4];
  if (!profilePath || !configPath || !outputPath || process.argv.length !== 5) failUsage();
  let profile: unknown;
  try {
    profile = JSON.parse(readBoundedFile(profilePath, MAX_AUTHORING_PROFILE_BYTES, '配置档案').toString('utf8')) as unknown;
  } catch {
    throw new Error('无法读取配置 JSON');
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('配置 JSON 结构无效');
  }
  const profileRecord = profile as Record<string, unknown>;
  if ('liteLlmConfigYaml' in profileRecord) {
    throw new Error('配置 JSON 不得内嵌 LiteLLM YAML；请使用第二个参数传入 config.yaml');
  }
  const configYaml = readBoundedFile(configPath, MAX_LITE_LLM_CONFIG_BYTES, 'LiteLLM 配置').toString('utf8');
  const payload = { ...profileRecord, liteLlmConfigYaml: configYaml };
  const password = await readPassword();
  const encrypted = encryptProvisioningPayload(payload, password);
  const target = path.resolve(outputPath);
  if (path.extname(target).toLowerCase() !== '.provision') throw new Error('输出文件必须使用 .provision 扩展名');
  if (fs.existsSync(target)) throw new Error('输出文件已存在，请更换文件名');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  const profileName = typeof profileRecord.profileName === 'string'
    ? profileRecord.profileName
    : '未命名配置';
  console.log(`已生成加密配置：${target}（${profileName}）`);
}

main().catch(() => {
  // Deliberately do not print validation details, secrets, or YAML content.
  console.error('生成加密配置失败');
  process.exitCode = 1;
});
