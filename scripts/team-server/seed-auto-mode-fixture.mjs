// 票 05 验收夹具：在隔离数据根里造一个「第四步视频工位」可用项目。
//
// 为什么不点按钮造数据：server 模式下要先有项目/分镜/供应商才能进第四步，
// 而这些创建接口的校验与本票无关。验收要证的是「自动模式在真实页面里
// 随真实上传状态切换」，所以只把**前置结构**写进库，尾帧图仍由浏览器真的上传。
//
// 用法（必须由 scripts/video-auto-mode.playwright.test.mjs 以相同环境变量调起）：
//   node scripts/team-server/seed-auto-mode-fixture.mjs --mode server --owner <userId>
//   node scripts/team-server/seed-auto-mode-fixture.mjs --mode local
//
// 输出一行 `FIXTURE_RESULT <json>`。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : '';
}

const mode = argument('--mode') || (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server' ? 'server' : 'local');
const owner = argument('--owner');
if (!['server', 'local'].includes(mode)) throw new Error(`未知 mode: ${mode}`);
if (mode === 'server' && !owner) throw new Error('server 模式夹具必须提供 --owner');

const { dataRoot } = await import('../../lib/data-root.ts');
const root = dataRoot();
const { getDb } = await import('../../lib/db.ts');
const db = getDb();

const storageRoot = path.join(root, 'storage');
const inputsDir = path.join(storageRoot, 'inputs');
fs.mkdirSync(inputsDir, { recursive: true });

const nowIso = () => new Date().toISOString();
const createdAt = nowIso();

async function writeImage(name, width, height, background) {
  const file = path.join(inputsDir, `${name}-${randomUUID()}.png`);
  await sharp({ create: { width, height, channels: 3, background } }).png().toFile(file);
  return file;
}

const imageProviderId = randomUUID();
const projectId = randomUUID();
const shotSetId = randomUUID();
const firstShotId = randomUUID();
const secondShotId = randomUUID();
const firstImageId = randomUUID();
const secondImageId = randomUUID();

const firstImagePath = await writeImage('shot-a', 1600, 900, '#3f7fbf');
const secondImagePath = await writeImage('shot-b', 1600, 900, '#bf7f3f');

db.transaction(() => {
  db.prepare(`
    INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    VALUES (?, '自动模式验收夹具供应商', 'http://127.0.0.1:9', '', 'fixture-not-a-real-key', 'gpt-image-2', 'openai-compatible', 1, 0)
  `).run(imageProviderId);
  // 公司 H3 / Wan：与本机 LiteLLM 占位同一形态，configured=true 才不会被面板过滤。
  // 队列会尝试连 127.0.0.1:4000 并失败——没有任何真实付费调用。
  // 启动时的 seed 已经写过这些 canonical ID，所以按 ID 追加缺失、再统一校正连接字段。
  const insertVideoProvider = db.prepare(`
    INSERT OR IGNORE INTO video_providers
      (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
    VALUES (?, ?, 'openai-video', 'COMPANY_VIDEO_BASE_URL', 'COMPANY_VIDEO_API_KEY', ?, ?, 1, 5, 'http://127.0.0.1:4000', 'litellm-local-passthrough', '', '')
  `);
  const fixVideoProvider = db.prepare(`
    UPDATE video_providers SET enabled = 1, baseUrl = 'http://127.0.0.1:4000',
      apiKey = 'litellm-local-passthrough', defaultModel = ? WHERE id = ?
  `);
  for (const [id, name, modelEnv, model] of [
    ['company-minimax-h3', '公司 MiniMax H3 · 2K', 'COMPANY_MINIMAX_H3_VIDEO_MODEL', 'minimax-h3'],
    ['company-wan-3-0', '公司万相 Wan 3.0 · 1080p', 'COMPANY_WAN_3_0_VIDEO_MODEL', 'wan-3.0'],
    // 非自动模式对照：可灵 3.0 仍应保持既有首尾帧行为。
    ['company-kling-3-0', '公司可灵 3.0', 'COMPANY_KLING_VIDEO_MODEL', 'kling-3.0'],
  ]) {
    insertVideoProvider.run(id, name, modelEnv, model);
    fixVideoProvider.run(model, id);
  }

  db.prepare(`
    INSERT INTO projects (id, name, createdAt, providerId, model, prompt, size, status, storeCode, productCode, productionType, editorName)
    VALUES (?, ?, ?, ?, 'gpt-image-2', '自动模式验收夹具：不调用任何真实供应商。', '1024x1024', 'draft', 'B店', 'AUTO-MODE', 'AI种草', '自动模式验收')
  `).run(projectId, `自动模式验收-${projectId.slice(0, 8)}`, createdAt, imageProviderId);

  const insertImage = db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, processedPath, mimeType, width, height, usage, createdAt)
    VALUES (?, ?, 'input', ?, ?, ?, NULL, 'image/png', 1600, 900, 'shot_source', ?)
  `);
  insertImage.run(firstImageId, projectId, path.basename(firstImagePath), firstImagePath, firstImagePath, createdAt);
  insertImage.run(secondImageId, projectId, path.basename(secondImagePath), secondImagePath, secondImagePath, createdAt);

  db.prepare(`
    INSERT INTO shot_sets (id, projectId, name, kind, status, createdAt)
    VALUES (?, ?, '自动模式验收分镜组', 'storyboard', 'approved', ?)
  `).run(shotSetId, projectId, createdAt);
  const insertShot = db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, createdAt) VALUES (?, ?, ?, ?, ?)`);
  insertShot.run(firstShotId, shotSetId, 1, firstImageId, createdAt);
  insertShot.run(secondShotId, shotSetId, 2, secondImageId, createdAt);
}).immediate();

let teamFiles = null;
if (mode === 'server') {
  const { registerReadyTeamFile } = await import('../../lib/team-service/files/registry.ts');
  const scope = db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'private', ?, ?, 'project', ?, ?, ?)
  `);
  db.transaction(() => {
    scope.run('project', projectId, owner, null, null, projectId, createdAt, createdAt);
    scope.run('shot_set', shotSetId, owner, 'project', projectId, projectId, createdAt, createdAt);
    for (const shotId of [firstShotId, secondShotId]) {
      scope.run('shot', shotId, owner, 'shot_set', shotSetId, projectId, createdAt, createdAt);
    }
    for (const imageId of [firstImageId, secondImageId]) {
      scope.run('image', imageId, owner, 'project', projectId, projectId, createdAt, createdAt);
    }
  }).immediate();

  teamFiles = [];
  for (const [imageId, imagePath] of [[firstImageId, firstImagePath], [secondImageId, secondImagePath]]) {
    teamFiles.push(registerReadyTeamFile(db, {
      storageRoot, absolutePath: imagePath, mimeType: 'image/png', ownerUserId: owner,
      references: [{ resourceType: 'image', resourceId: imageId, role: 'input' }],
    }).id);
  }
}

db.close();

const payload = {
  mode,
  dataRoot: root,
  projectId,
  shotSetId,
  shotIds: [firstShotId, secondShotId],
  imageIds: [firstImageId, secondImageId],
  firstImageSha256: createHash('sha256').update(fs.readFileSync(firstImagePath)).digest('hex'),
  teamFileIds: teamFiles,
  repoRoot,
};
console.log(`FIXTURE_RESULT ${JSON.stringify(payload)}`);
