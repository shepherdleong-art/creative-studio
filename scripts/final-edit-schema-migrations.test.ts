import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FINAL_EDIT_MIGRATIONS, initFinalEditSchema } from '../lib/final-edit/schema.ts';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE final_edit_schema_migrations (
    version INTEGER PRIMARY KEY,
    appliedAt TEXT NOT NULL
  )
`);

for (const migration of FINAL_EDIT_MIGRATIONS.filter(({ version }) => version <= 2)) {
  db.transaction(() => {
    db.exec(migration.sql);
    db.prepare(`INSERT INTO final_edit_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(
      migration.version,
      '2026-06-01T00:00:00.000Z',
    );
  })();
}

db.prepare(`
  INSERT INTO final_edit_groups (
    id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash,
    narrationConfigJson, coverTitleJson, textStylesJson, status, phase, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'legacy-group', 'legacy-project', 'legacy-script', 'legacy-shot-set',
  '{"version":1,"title":"旧脚本"}', 'legacy-hash', '{}', '{"main":"旧标题"}', '{}',
  'ready', 'previewing', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
);
db.prepare(`
  INSERT INTO final_edit_variants (
    id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'legacy-variant', 'legacy-group', 1, 'vertical-1080x1920',
  '{"durationUs":1000000,"clips":[]}', '{}', '{}',
  '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
);
db.prepare(`
  INSERT INTO final_edit_tts_providers (
    id, name, type, baseUrl, apiKey, keyEnv, model, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'legacy-tts', '旧 TTS', 'legacy-json', 'https://legacy.invalid', '', '', 'legacy-model',
  '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
);

initFinalEditSchema(db);

const group = db.prepare(`
  SELECT scriptSnapshotJson, editedNarrationText, scriptSyncState,
         sourceScriptUpdatedAt, selectedMaterialKeysJson
  FROM final_edit_groups WHERE id = 'legacy-group'
`).get() as Record<string, unknown>;
assert.equal(group.scriptSnapshotJson, '{"version":1,"title":"旧脚本"}');
assert.equal(group.editedNarrationText, '');
assert.equal(group.scriptSyncState, 'synced');
assert.equal(group.sourceScriptUpdatedAt, null);
assert.equal(group.selectedMaterialKeysJson, '[]');

const variant = db.prepare(`
  SELECT timelineJson, previewRelativePath, matchDiagnosticsJson
  FROM final_edit_variants WHERE id = 'legacy-variant'
`).get() as Record<string, unknown>;
assert.equal(variant.timelineJson, '{"durationUs":1000000,"clips":[]}');
assert.equal(variant.previewRelativePath, null);
assert.equal(variant.matchDiagnosticsJson, '{}');

const tts = db.prepare(`
  SELECT model, costPerThousandCharacters
  FROM final_edit_tts_providers WHERE id = 'legacy-tts'
`).get() as Record<string, unknown>;
assert.equal(tts.model, 'legacy-model');
assert.equal(tts.costPerThousandCharacters, 0);

assert.deepEqual(
  db.prepare(`SELECT version FROM final_edit_schema_migrations ORDER BY version`).all().map((row) => (row as { version: number }).version),
  FINAL_EDIT_MIGRATIONS.map(({ version }) => version),
);
assert.ok(db.prepare(`SELECT 1 FROM project_artifacts LIMIT 1`).get() === undefined);

initFinalEditSchema(db);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS count FROM final_edit_groups WHERE id = 'legacy-group'`).get() as { count: number }).count,
  1,
  '再次初始化不得重复或丢失旧数据',
);

db.close();
console.log('final-edit schema migration tests passed');
