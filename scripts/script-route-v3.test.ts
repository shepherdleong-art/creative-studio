import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { ScriptOutputV3 } from '../lib/script-providers/types.ts';

const { generateAndPersistScriptV3 } = await import('../lib/script-generation-v3-service.ts');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO shot_sets (id, projectId, name) VALUES
    ('set-owned', 'project-a', '空分镜组'),
    ('set-foreign', 'project-b', '其他项目');
`);

const script: ScriptOutputV3 = {
  version: 3,
  title: '下班后的云感支撑',
  coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托', source: 'model' },
  platform: '小红书',
  tone: '温柔种草',
  templateId: 'scene_seeding',
  template: '场景种草',
  shotSetId: 'set-owned',
  targetDurationSec: 15,
  targetNarrationDurationSec: 14.166666666666666,
  contentCharacterCount: 55,
  estimatedNarrationDurationSec: 55 / 4.2,
  durationStatus: 'qualified',
  durationPolicyVersion: 'zh-tts-budget-v1',
  segments: [{
    id: 'segment-1', narration: '带标点的自然口播。', subtitle: '带标点的自然口播',
    sellingPointRefs: ['112°承托'], visualIntent: '靠背承托特写', visualKeywords: ['承托'],
  }],
  fullScript: '带标点的自然口播。',
  fullSubtitle: '带标点的自然口播',
};

const project = {
  name: '沙发项目', productName: '云感沙发', productCode: 'SF-A1', productCategory: '家具',
  targetAudience: '久坐上班族', scriptTone: '温柔种草', scriptPlatform: '小红书',
  sellingPointsJson: '[{"title":"112°承托"}]',
};

let receivedInput: object | null = null;
const response = await generateAndPersistScriptV3({
  projectId: 'project-a',
  project,
  body: {
    shotSetId: 'set-owned',
    selectedSellingPoints: [{ title: '112°承托', priority: 'highest', reason: '真实卖点' }],
    templateId: 'scene_seeding',
    targetDurationSec: 15,
    providerId: 'fake-provider',
  },
}, {
  db,
  createId: () => 'draft-v3',
  providerMeta: () => ({
    id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
    apiStyle: 'openai-compatible', supportsVision: false,
  }),
  completeJson: async () => ({}),
  generate: async (input) => {
    receivedInput = input;
    return { script, attempts: 2 };
  },
});

assert.equal(response.status, 200);
assert.equal('shots' in (receivedInput || {}), false, 'V3 生成输入不得包含图片或分镜上下文');
assert.deepEqual(response.body, {
  draftId: 'draft-v3', script, provider: 'fake-provider', model: 'fake-model', attempts: 2,
});
const row = db.prepare(`SELECT inputSnapshot, outputJson FROM script_drafts WHERE id='draft-v3'`).get() as {
  inputSnapshot: string;
  outputJson: string;
};
const snapshot = JSON.parse(row.inputSnapshot) as Record<string, unknown>;
assert.equal(snapshot.shotSetId, 'set-owned');
assert.equal(snapshot.durationPolicyVersion, 'zh-tts-budget-v1');
assert.deepEqual(snapshot.targetCharacterRange, [54, 59]);
assert.equal('imageBase64' in snapshot, false);
assert.deepEqual(JSON.parse(row.outputJson), script);

const foreignResponse = await generateAndPersistScriptV3({
  projectId: 'project-a', project,
  body: { shotSetId: 'set-foreign', templateId: 'scene_seeding', targetDurationSec: 15 },
}, {
  db,
  completeJson: async () => ({}),
  providerMeta: () => undefined,
  generate: async () => ({ script, attempts: 1 }),
});
assert.equal(foreignResponse.status, 400);
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM script_drafts`).get() as { count: number }).count, 1);

db.close();
console.log('script route v3 tests passed');
