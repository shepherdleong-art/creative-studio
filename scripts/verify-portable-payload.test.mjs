import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(root, 'scripts', 'verify-portable-payload.mjs');
const fixtures = [];
const modelAliases = [
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedream-5-0-image',
  'image2-high',
  'image2-medium',
  'image2-low',
  'qiniuyun/gpt-image-2-medium',
  'nano-banana-2.5',
  'nano-banana-3.0',
  'nano-banana-3.1',
  'kling-1.6',
  'kling-2.0',
  'kling-2.1',
  'kling-2.5',
  'kling-2.6',
  'kling-3.0',
  'kling-3.0-Omni',
  'kling-O1',
  'GPT-5-6-Luna-Standard',
  'GPT-5-5',
];

function makePayload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-payload-verify-'));
  fixtures.push(dir);
  fs.mkdirSync(path.join(dir, '.next', 'standalone'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const config = [
    'model_list:',
    ...modelAliases.flatMap((model, index) => {
      const key = `sk-portable-fixture-${String(index).padStart(2, '0')}`;
      return [
        `  - model_name: ${model}`,
        '    litellm_params:',
        `      model: openai/${model}`,
        '      api_base: https://gateway.example.test/v1',
        ...(index % 4 === 0 ? [`      api_key: "${key}`, '"'] : [`      api_key: ${key}`]),
      ];
    }),
    'router_settings:',
    '  routing_strategy: simple-shuffle',
    'num_retries: 2',
    'timeout: 600',
    'litellm_settings:',
    '  drop_params: true',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), config);
  fs.writeFileSync(path.join(dir, '.env.local'), [
    'CREATIVE_STUDIO_COS_SECRET_ID=fixture-secret-id',
    'CREATIVE_STUDIO_COS_SECRET_KEY=fixture-secret-key',
    'CREATIVE_STUDIO_COS_DOMAIN=https://cos.example.test',
    'CREATIVE_STUDIO_COS_PREFIX=creative-studio',
    'CREATIVE_STUDIO_COS_SIGN_HOST=cos.example.test',
    'DOUBAO_TTS_API_KEY=fixture-doubao-key',
    'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.next', 'standalone', 'server.js'), 'console.log("clean fixture");\n');
  return dir;
}

function verify(payload) {
  return spawnSync(process.execPath, [verifier, '--payload', payload], { encoding: 'utf8', timeout: 120_000 });
}

try {
  const clean = makePayload();
  const cleanResult = verify(clean);
  assert.equal(cleanResult.status, 0, `干净 payload 应通过：\n${cleanResult.stdout}\n${cleanResult.stderr}`);

  const leakedBackup = makePayload();
  fs.writeFileSync(
    path.join(leakedBackup, '.next', 'standalone', 'config.yaml.backup-20260814-172847'),
    'api_key: sk-old-leaked-key\n',
  );
  const backupResult = verify(leakedBackup);
  assert.notEqual(backupResult.status, 0, '嵌套 config.yaml.backup 必须阻断发布');
  assert.match(`${backupResult.stdout}${backupResult.stderr}`, /config\.yaml\.backup/);

  const duplicatedSecret = makePayload();
  const secret = 'sk-portable-fixture-00';
  fs.writeFileSync(path.join(duplicatedSecret, '.next', 'standalone', 'server.js'), `const leaked = '${secret}';\n`);
  const secretResult = verify(duplicatedSecret);
  assert.notEqual(secretResult.status, 0, '允许位置以外出现同一密钥必须阻断发布');
  assert.ok(!`${secretResult.stdout}${secretResult.stderr}`.includes(secret), '扫描输出绝不能回显密钥值');

  const invalidEnv = makePayload();
  fs.appendFileSync(path.join(invalidEnv, '.env.local'), 'UNREVIEWED_API_KEY=fixture-extra\n');
  const envResult = verify(invalidEnv);
  assert.notEqual(envResult.status, 0, '未确认的环境变量必须阻断发布');
  assert.match(`${envResult.stdout}${envResult.stderr}`, /UNREVIEWED_API_KEY/);

  const disabledScheduler = makePayload();
  const envPath = path.join(disabledScheduler, '.env.local');
  fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8').replace(
    'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1',
    'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=0',
  ));
  const schedulerResult = verify(disabledScheduler);
  assert.notEqual(schedulerResult.status, 0, '0.6.0 免安装包必须开启脚本调度器');
  assert.match(`${schedulerResult.stdout}${schedulerResult.stderr}`, /SCHEDULER/);

  const unknownConfigField = makePayload();
  fs.appendFileSync(path.join(unknownConfigField, 'config.yaml'), 'unreviewed_secret: fixture-hidden\n');
  const unknownFieldResult = verify(unknownConfigField);
  assert.notEqual(unknownFieldResult.status, 0, 'config.yaml 未审核字段必须阻断发布');
  assert.match(`${unknownFieldResult.stdout}${unknownFieldResult.stderr}`, /unreviewed_secret/);

  const secretLikeAlias = makePayload();
  const secretLikeAliasPath = path.join(secretLikeAlias, 'config.yaml');
  const secretLikeValue = 'sk-secret-must-not-be-echoed';
  fs.writeFileSync(
    secretLikeAliasPath,
    fs.readFileSync(secretLikeAliasPath, 'utf8').replace(modelAliases[0], secretLikeValue),
  );
  const aliasResult = verify(secretLikeAlias);
  assert.notEqual(aliasResult.status, 0, '未审核模型别名必须阻断发布');
  assert.ok(!`${aliasResult.stdout}${aliasResult.stderr}`.includes(secretLikeValue), '错误输出不得回显未知配置值');

  const misplacedApiKey = makePayload();
  const misplacedConfigPath = path.join(misplacedApiKey, 'config.yaml');
  const misplacedConfig = fs.readFileSync(misplacedConfigPath, 'utf8')
    .replace('      api_key: sk-portable-fixture-02\n', '')
    .replace(
      '      api_key: sk-portable-fixture-01\n',
      '      api_key: sk-portable-fixture-01\n      api_key: sk-portable-fixture-extra\n',
    );
  fs.writeFileSync(misplacedConfigPath, misplacedConfig);
  const misplacedResult = verify(misplacedApiKey);
  assert.notEqual(misplacedResult.status, 0, 'api_key 总数相同但分配到错误模型时必须阻断发布');
  assert.match(`${misplacedResult.stdout}${misplacedResult.stderr}`, /有效且无重复键/);
} finally {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('portable payload verification tests passed');
