import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScriptProviderRuntimeConfig } from '../lib/script-providers/config.ts';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-usage-llm-context-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const indexSource = read('lib/script-providers/index.ts');
const generationRouteSource = read('app/api/projects/[id]/script-generation/route.ts');
const analysisRouteSource = read('app/api/projects/[id]/script/route.ts');

assert.match(indexSource, /usageContext\??\s*:/, 'completeJson must expose optional top-level usageContext');
assert.match(indexSource, /enabled:\s*true/, 'completeJson/analyzeSellingPoints must force usage accounting on');
assert.match(indexSource, /export async function analyzeSellingPoints[\s\S]*usageContext/, 'analyzeSellingPoints must expose usageContext');
assert.match(generationRouteSource, /usageContext\s*:\s*\{[\s\S]*projectId[\s\S]*refType\s*:\s*['"]script-generation['"][\s\S]*refId/, 'script generation must pass stable project usage context');
assert.match(analysisRouteSource, /usageContext\s*:\s*\{[\s\S]*projectId[\s\S]*refType\s*:\s*['"]script-analysis['"][\s\S]*refId\s*:\s*projectId/, 'script analysis must pass stable project usage context');

let closeDb: (() => void) | undefined;
try {
  const { getDb, closeDb: importedCloseDb } = await import('../lib/db.ts');
  closeDb = importedCloseDb;
  const { beginLlmUsageCall } = await import('../lib/usage-llm.ts');

  const runtime: ScriptProviderRuntimeConfig = {
    id: 'gpt',
    name: '公司 GPT',
    type: 'openai-compatible',
    apiStyle: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:4000',
    apiKey: 'local-key',
    model: 'GPT-5-6-Luna-Standard',
    maxTokens: 16_384,
    enabled: true,
    configured: true,
    missing: [],
    hasApiKey: true,
    supportsVision: true,
    visionCostPerRequest: 0,
    executionScope: 'company',
  };

  const db = getDb();
  db.exec('DELETE FROM usage_ledger; DELETE FROM usage_call_events;');
  const attempt = beginLlmUsageCall(runtime, runtime.model, {
    enabled: true,
    projectId: 'project-42',
    refType: 'script-generation',
    refId: 'generation-7',
  });
  assert.ok(attempt, 'exact company GPT identity should create usage evidence');
  const event = db.prepare('SELECT snapshotJson, projectId, refType, refId FROM usage_call_events').get() as Record<string, unknown>;
  assert.equal(event.projectId, 'project-42');
  assert.equal(event.refType, 'script-generation');
  assert.equal(event.refId, 'generation-7');
  const snapshot = JSON.parse(String(event.snapshotJson)) as { provider: { providerType: string }; projectId: string; refType: string; refId: string };
  assert.equal(snapshot.provider.providerType, 'openai-compatible');
  assert.equal(snapshot.projectId, 'project-42');
  assert.equal(snapshot.refType, 'script-generation');
  assert.equal(snapshot.refId, 'generation-7');

  db.exec('DELETE FROM usage_ledger; DELETE FROM usage_call_events;');
  const nonCanonicalType = beginLlmUsageCall({ ...runtime, type: 'database-custom-type' }, runtime.model, { enabled: true });
  assert.equal(nonCanonicalType, null, 'usage providerType must use database type, never apiStyle as a substitute');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_call_events').get() as { count: number }).count, 0);
} finally {
  try { closeDb?.(); } catch { /* cleanup is best effort */ }
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows may hold WAL briefly */ }
}

console.log('usage LLM context tests passed');
