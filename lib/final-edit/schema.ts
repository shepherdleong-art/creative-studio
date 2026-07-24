import type Database from 'better-sqlite3';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS final_edit_groups (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, scriptDraftId TEXT NOT NULL, shotSetId TEXT NOT NULL,
        scriptSnapshotJson TEXT NOT NULL, narrationHash TEXT NOT NULL,
        analysisProviderId TEXT NOT NULL DEFAULT '', analysisModel TEXT NOT NULL DEFAULT '',
        narrationConfigJson TEXT NOT NULL, narrationAudioPath TEXT,
        narrationDurationUs INTEGER NOT NULL DEFAULT 0, wordTimingsJson TEXT NOT NULL DEFAULT '[]',
        subtitleStateJson TEXT NOT NULL DEFAULT '[]', coverTitleJson TEXT NOT NULL,
        textStylesJson TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'validating',
        revision INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(projectId, scriptDraftId, narrationHash)
      );
      CREATE INDEX IF NOT EXISTS idx_final_edit_groups_project_script ON final_edit_groups(projectId, scriptDraftId, createdAt);

      CREATE TABLE IF NOT EXISTS final_edit_variants (
        id TEXT PRIMARY KEY, groupId TEXT NOT NULL, indexNum INTEGER NOT NULL, outputPreset TEXT NOT NULL,
        timelineJson TEXT NOT NULL, bgmJson TEXT NOT NULL, coverJson TEXT NOT NULL,
        issuesJson TEXT NOT NULL DEFAULT '[]', overlapJson TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 0, lastRenderedRevision INTEGER,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(groupId, indexNum), FOREIGN KEY(groupId) REFERENCES final_edit_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS final_edit_asset_analysis (
        videoJobId TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, fileFingerprint TEXT NOT NULL,
        providerId TEXT NOT NULL, model TEXT NOT NULL, analyzerVersion TEXT NOT NULL,
        status TEXT NOT NULL, mediaJson TEXT NOT NULL DEFAULT '{}', generatedJson TEXT NOT NULL DEFAULT '{}',
        manualOverrideJson TEXT NOT NULL DEFAULT '{}', autoUseDisabled INTEGER NOT NULL DEFAULT 0,
        errorCode TEXT, errorMessage TEXT, analyzedAt TEXT, updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS final_edit_jobs (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, groupId TEXT, variantId TEXT,
        kind TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
        requestKey TEXT NOT NULL UNIQUE, inputSnapshotJson TEXT NOT NULL, outputJson TEXT,
        errorCode TEXT, errorMessage TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        startedAt TEXT, finishedAt TEXT, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_final_edit_jobs_status ON final_edit_jobs(status, createdAt);

      CREATE TABLE IF NOT EXISTS final_edit_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scopeKind TEXT NOT NULL, scopeId TEXT NOT NULL,
        revision INTEGER NOT NULL, stateJson TEXT NOT NULL, commandJson TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(scopeKind, scopeId, revision)
      );

      CREATE TABLE IF NOT EXISTS final_edit_proposals (
        id TEXT PRIMARY KEY, variantId TEXT NOT NULL, baseRevision INTEGER NOT NULL, kind TEXT NOT NULL,
        proposalJson TEXT NOT NULL, issuesJson TEXT NOT NULL, status TEXT NOT NULL,
        createdAt TEXT NOT NULL, appliedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS final_edit_usage (
        scopeKind TEXT NOT NULL, scopeId TEXT NOT NULL, projectId TEXT NOT NULL, shotSetId TEXT NOT NULL,
        groupId TEXT NOT NULL, variantId TEXT NOT NULL, assetKind TEXT NOT NULL, assetKey TEXT NOT NULL,
        createdAt TEXT NOT NULL, UNIQUE(scopeKind, scopeId, assetKind, assetKey)
      );

      CREATE TABLE IF NOT EXISTS final_edit_bgm_tracks (
        id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, fileFingerprint TEXT NOT NULL,
        durationUs INTEGER NOT NULL, format TEXT NOT NULL, loudnessJson TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL, errorMessage TEXT, scannedAt TEXT NOT NULL, UNIQUE(fileFingerprint)
      );

      CREATE TABLE IF NOT EXISTS final_edit_overlay_bundles (
        id TEXT PRIMARY KEY, groupId TEXT NOT NULL, outputPreset TEXT NOT NULL,
        groupRevision INTEGER NOT NULL, specHash TEXT NOT NULL, manifestJson TEXT NOT NULL,
        relativeDir TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(groupId, outputPreset, specHash)
      );

      CREATE TABLE IF NOT EXISTS final_edit_title_presets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, stylesByPresetJson TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS final_edit_tts_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, isBuiltin INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS final_edit_project_settings (
        projectId TEXT PRIMARY KEY,
        autoUseLimit INTEGER NOT NULL DEFAULT 2 CHECK(autoUseLimit BETWEEN 1 AND 10),
        updatedAt TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE final_edit_jobs ADD COLUMN estimatedCost REAL;
      ALTER TABLE final_edit_jobs ADD COLUMN costCurrency TEXT NOT NULL DEFAULT 'CNY';
      ALTER TABLE final_edit_tts_providers ADD COLUMN costPerThousandCharacters REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS final_edit_external_assets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        shotSetId TEXT NOT NULL,
        originalFilename TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        thumbnailRelativePath TEXT,
        mimeType TEXT NOT NULL,
        mediaKind TEXT NOT NULL CHECK(mediaKind IN ('video','image')),
        durationUs INTEGER NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        fileFingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(shotSetId, fileFingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_final_edit_external_assets_group
        ON final_edit_external_assets(projectId, shotSetId, createdAt);
    `,
  },
];

export function initFinalEditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS final_edit_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `);
  for (const migration of MIGRATIONS) {
    const applied = db.prepare(`SELECT 1 FROM final_edit_schema_migrations WHERE version = ?`).get(migration.version);
    if (applied) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO final_edit_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(migration.version, new Date().toISOString());
    })();
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO final_edit_tts_providers
      (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, createdAt, updatedAt)
    VALUES ('vapi-qwen3-tts', 'V-API Qwen3 TTS Flash', 'vapi-qwen-json-url', 'https://api.v3.cm', '', 'VAPI_TTS_API_KEY', 'qwen3-tts-flash', 1, 1, ?, ?)
  `).run(now, now);
}
