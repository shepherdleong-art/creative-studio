import type Database from 'better-sqlite3';
import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_DISPLAY_NAME,
  UNIFIED_IMAGE_MODEL_KEY,
  unifiedImageCompatibleChannels,
} from './catalog.ts';
import {
  inferUnifiedImageOutputFromPreset,
} from './requests.ts';

/**
 * Older Image 2 projects still point at the exact qiniu/tencent channel rows.
 * Preserve every historical job, but move the project default to the unified
 * anchor before new tasks are created. Projects whose locked size is not an
 * executable unified combination are intentionally left untouched.
 */
export function migrateLegacyUnifiedImageProjects(
  db: Database.Database,
  options: { mode?: 'local' | 'server' } = {},
): number {
  const mode = options.mode ?? (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local');
  if (mode !== 'server') return 0;
  const channelIds = UNIFIED_IMAGE_CHANNELS.map((channel) => channel.providerId);
  const channelModels = UNIFIED_IMAGE_CHANNELS.map((channel) => channel.model);
  const projects = db.prepare(`
    SELECT id, size FROM projects
    WHERE providerId IN (${channelIds.map(() => '?').join(',')})
      AND model IN (${channelModels.map(() => '?').join(',')})
  `).all(...channelIds, ...channelModels) as Array<{ id: string; size: string }>;
  if (projects.length === 0) return 0;

  return db.transaction(() => {
    db.prepare(`
      INSERT INTO providers
        (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
      SELECT ?, ?, '', '', '', ?, 'unified-image', 1, NULL
      WHERE NOT EXISTS (SELECT 1 FROM providers WHERE id = ?)
    `).run(
      UNIFIED_IMAGE_ANCHOR_ID,
      UNIFIED_IMAGE_DISPLAY_NAME,
      UNIFIED_IMAGE_MODEL_KEY,
      UNIFIED_IMAGE_ANCHOR_ID,
    );
    let migrated = 0;
    const update = db.prepare(`
      UPDATE projects
      SET providerId = ?, model = ?, quality = 'auto'
      WHERE id = ? AND providerId = ? AND model = ?
    `);
    for (const project of projects) {
      const output = inferUnifiedImageOutputFromPreset(project.size);
      if (!output || unifiedImageCompatibleChannels(output.tier, output.ratio).length === 0) continue;
      const current = db.prepare('SELECT providerId, model FROM projects WHERE id = ?')
        .get(project.id) as { providerId: string; model: string } | undefined;
      if (!current || !channelIds.includes(current.providerId) || !channelModels.includes(current.model)) continue;
      migrated += update.run(
        UNIFIED_IMAGE_ANCHOR_ID,
        UNIFIED_IMAGE_MODEL_KEY,
        project.id,
        current.providerId,
        current.model,
      ).changes;
    }
    return migrated;
  }).immediate();
}
