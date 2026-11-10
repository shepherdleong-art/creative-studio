// node scripts/unified-audit-regressions.test.ts
// Pure/projection regressions for legacy project migration and exact-channel hiding.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const previousMode = process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';

const {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
} = await import('../lib/media-core/unified-media/catalog.ts');
const { migrateLegacyUnifiedImageProjects } = await import('../lib/media-core/unified-media/project-migration.ts');
const { projectTeamImageModels } = await import('../lib/media-core/unified-media/model-list.ts');
const { projectTeamVideoModels } = await import('../lib/media-core/unified-media/video-model-list.ts');

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseUrl TEXT NOT NULL DEFAULT '',
    apiKeyEnv TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'openai-compatible',
    enabled INTEGER NOT NULL DEFAULT 1,
    defaultCostPerImage REAL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    size TEXT NOT NULL,
    quality TEXT NOT NULL DEFAULT 'medium',
    FOREIGN KEY (providerId) REFERENCES providers(id)
  );
`);
for (const channel of UNIFIED_IMAGE_CHANNELS) {
  db.prepare(`INSERT INTO providers
    (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES (?, ?, 'https://legacy.test', 'legacy-key', ?, 'gateway-task-image', 1)`)
    .run(channel.providerId, channel.providerId, channel.model);
}
const qiniu = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
db.prepare(`INSERT INTO projects (id, name, providerId, model, size, quality)
  VALUES ('supported', '旧项目-可迁移', ?, ?, '1728x2304', 'medium')`)
  .run(qiniu.providerId, qiniu.model);
db.prepare(`INSERT INTO projects (id, name, providerId, model, size, quality)
  VALUES ('unsupported', '旧项目-非法组合', ?, ?, '720x1280', 'medium')`)
  .run(qiniu.providerId, qiniu.model);
db.prepare(`INSERT INTO projects (id, name, providerId, model, size, quality)
  VALUES ('other-model', '其他模型', ?, 'seedream-other', '1728x2304', 'medium')`)
  .run(qiniu.providerId);

assert.equal(migrateLegacyUnifiedImageProjects(db), 1);
assert.deepEqual(
  db.prepare(`SELECT providerId, model, quality FROM projects WHERE id = 'supported'`).get(),
  { providerId: UNIFIED_IMAGE_ANCHOR_ID, model: UNIFIED_IMAGE_MODEL_KEY, quality: 'auto' },
);
assert.deepEqual(
  db.prepare(`SELECT providerId, model, quality FROM projects WHERE id = 'unsupported'`).get(),
  { providerId: qiniu.providerId, model: qiniu.model, quality: 'medium' },
  'a non-executable old size must not be silently rewritten',
);
assert.deepEqual(
  db.prepare(`SELECT providerId, model FROM projects WHERE id = 'other-model'`).get(),
  { providerId: qiniu.providerId, model: 'seedream-other' },
);
assert.equal(migrateLegacyUnifiedImageProjects(db), 0, 'migration is idempotent');

const imageRows = [
  {
    id: 'custom-image2', name: '自定义同名 Image2', model: UNIFIED_IMAGE_CHANNELS[0].model,
    type: 'gateway-task-image', enabled: 1, apiKey: 'custom-key', baseUrl: 'https://custom.test',
  },
  {
    id: 'seedream-safe', name: 'Seedream', model: 'doubao-seedream-5-0-pro-image',
    type: 'gateway-task-image', enabled: 1, apiKey: 'seed-key', baseUrl: 'https://seed.test',
  },
];
const imageProjection = projectTeamImageModels(imageRows, { mode: 'server', unifiedAvailable: true });
assert.equal(imageProjection[0]?.id, UNIFIED_IMAGE_ANCHOR_ID);
assert.equal(imageProjection.some((row) => row.id === 'custom-image2'), false,
  'custom providers using the exact real Image2 model must not bypass the unified entry');
assert.equal(imageProjection.some((row) => row.id === 'seedream-safe'), true,
  'other image models remain visible');
assert.equal(
  projectTeamImageModels(imageRows, { mode: 'local', unifiedAvailable: false })
    .some((row) => row.id === UNIFIED_IMAGE_ANCHOR_ID),
  false,
  'local mode keeps the legacy list',
);

const videoRows = [
  { id: 'custom-kling', name: '自定义同名可灵', defaultModel: UNIFIED_KLING3_CHANNELS[1].model },
  { id: 'seedance-safe', name: 'Seedance', defaultModel: 'doubao-seedance-2-5-260628' },
];
const videoProjection = projectTeamVideoModels(videoRows, {
  mode: 'server', unifiedAvailable: true, unifiedCapabilities: {},
});
assert.equal(videoProjection[0]?.id, UNIFIED_KLING3_ANCHOR_ID);
assert.equal(videoProjection.some((row) => row.id === 'custom-kling'), false,
  'custom providers using the exact real Kling model must not bypass the unified entry');
assert.equal(videoProjection.some((row) => row.id === 'seedance-safe'), true);

db.close();
if (previousMode === undefined) delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
else process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = previousMode;
console.log('unified audit regressions passed');
