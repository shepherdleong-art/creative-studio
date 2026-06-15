import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'workbench.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables(db);
    seedAllVideo();
  }
  return db;
}

import { seedAllVideo } from './seed';

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKeyEnv TEXT NOT NULL DEFAULT '',
      apiKey TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'gpt-image-2',
      type TEXT NOT NULL DEFAULT 'openai-compatible',
      enabled INTEGER NOT NULL DEFAULT 1,
      defaultCostPerImage REAL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negativePrompt TEXT DEFAULT '',
      size TEXT NOT NULL DEFAULT '1024x1024',
      quality TEXT NOT NULL DEFAULT 'standard',
      concurrency INTEGER NOT NULL DEFAULT 3,
      maxAttempts INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'draft',
      runId TEXT,
      referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject',
      FOREIGN KEY (providerId) REFERENCES providers(id)
    );


    CREATE TABLE IF NOT EXISTS image_assets (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      role TEXT NOT NULL CHECK(role IN ('reference', 'input', 'output')),
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      originalPath TEXT,
      processedPath TEXT,
      mimeType TEXT NOT NULL DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      originalWidth INTEGER,
      originalHeight INTEGER,
      processedWidth INTEGER,
      processedHeight INTEGER,
      originalSizeBytes INTEGER,
      processedSizeBytes INTEGER,
      preprocessingEnabled INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      inputImageId TEXT NOT NULL,
      referenceImageIds TEXT NOT NULL DEFAULT '[]',
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      size TEXT NOT NULL DEFAULT '1024x1024',
      quality TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 2,
      startedAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER,
      estimatedCost REAL,
      errorMessage TEXT,
      reviewMark TEXT DEFAULT '',
      outputImageId TEXT,
      providerTaskId TEXT,
      providerStatus TEXT,
      providerRawResponse TEXT,
      submittedAt TEXT,
      lastPolledAt TEXT,
      pollCount INTEGER DEFAULT 0,
      remoteImageUrl TEXT,
      postprocessTarget TEXT,
      parentJobId TEXT,
      revision INTEGER DEFAULT 0,
      referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject',
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (inputImageId) REFERENCES image_assets(id),
      FOREIGN KEY (outputImageId) REFERENCES image_assets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(projectId);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_image_assets_project ON image_assets(projectId);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id TEXT PRIMARY KEY,
      jobId TEXT,
      projectId TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_logs_project ON job_logs(projectId);
    CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(jobId);
  `);

  // Migrations for existing DBs
  const migrations = [
    `ALTER TABLE providers ADD COLUMN apiKey TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN reviewMark TEXT DEFAULT ''`,
    `ALTER TABLE image_assets ADD COLUMN originalPath TEXT`,
    `ALTER TABLE image_assets ADD COLUMN processedPath TEXT`,
    `ALTER TABLE image_assets ADD COLUMN originalWidth INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN originalHeight INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN processedWidth INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN processedHeight INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN originalSizeBytes INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN processedSizeBytes INTEGER`,
    `ALTER TABLE image_assets ADD COLUMN preprocessingEnabled INTEGER DEFAULT 1`,
    `ALTER TABLE jobs ADD COLUMN providerTaskId TEXT`,
    `ALTER TABLE jobs ADD COLUMN providerStatus TEXT`,
    `ALTER TABLE jobs ADD COLUMN providerRawResponse TEXT`,
    `ALTER TABLE jobs ADD COLUMN submittedAt TEXT`,
    `ALTER TABLE jobs ADD COLUMN lastPolledAt TEXT`,
    `ALTER TABLE jobs ADD COLUMN pollCount INTEGER DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN remoteImageUrl TEXT`,
    `ALTER TABLE projects ADD COLUMN runId TEXT`,
    `ALTER TABLE jobs ADD COLUMN postprocessTarget TEXT`,
    `ALTER TABLE jobs ADD COLUMN parentJobId TEXT`,
    `ALTER TABLE jobs ADD COLUMN revision INTEGER DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'`,
    `ALTER TABLE jobs ADD COLUMN referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'`,
    `ALTER TABLE projects ADD COLUMN timeoutMs INTEGER NOT NULL DEFAULT 600000`,
    `ALTER TABLE projects ADD COLUMN workflowType TEXT NOT NULL DEFAULT 'legacy_batch_edit'`,
    `ALTER TABLE projects ADD COLUMN productName TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN productCode TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN productCategory TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN scenePrompt TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN shotPrompt TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN targetAudience TEXT DEFAULT ''`,
    `ALTER TABLE projects ADD COLUMN scriptTone TEXT DEFAULT '种草'`,
    `ALTER TABLE projects ADD COLUMN scriptPlatform TEXT DEFAULT '通用'`,
    `ALTER TABLE projects ADD COLUMN sellingPointsJson TEXT DEFAULT '[]'`,
    `ALTER TABLE projects ADD COLUMN sellingPointAnalysisJson TEXT DEFAULT ''`,
    `ALTER TABLE image_assets ADD COLUMN usage TEXT DEFAULT ''`,
    `UPDATE providers SET type = 'packy-images' WHERE baseUrl LIKE '%packyapi.com%' AND model = 'gpt-image-2' AND type = 'openai-compatible'`,
    `UPDATE providers SET type = 'packy-gemini-image' WHERE baseUrl LIKE '%packyapi.com%' AND model IN ('gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview')`,
    `UPDATE video_providers SET defaultModel = 'kling-v3' WHERE id = 'kling-3' AND defaultModel IN ('kling-3.0', 'kling-v3.0-i2v', 'kling-v3-0')`,
    `UPDATE video_providers SET defaultModel = 'doubao-seedance-2-0-260128' WHERE id = 'jimeng-2' AND defaultModel = 'jimeng-2.0'`,
    `INSERT OR IGNORE INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec) VALUES ('kling-2-5', '可灵 2.5', 'kling', 'KLING_VIDEO_BASE_URL', 'KLING_VIDEO_API_KEY', 'KLING_2_5_VIDEO_MODEL', 'kling-v2-5-turbo', 1, 5)`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* Column already exists */ }
  }

  // Ensure job_logs table exists without FKs (for older DBs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id TEXT PRIMARY KEY,
      jobId TEXT,
      projectId TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Scene references, shot sets, and shots
  db.exec(`
    CREATE TABLE IF NOT EXISTS scene_references (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      imageAssetId TEXT NOT NULL,
      sourceJobId TEXT,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      category TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (imageAssetId) REFERENCES image_assets(id)
    );

    CREATE TABLE IF NOT EXISTS shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      category TEXT DEFAULT '',
      sceneReferenceId TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generating','reviewing','approved','video_ready')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (sceneReferenceId) REFERENCES scene_references(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      shotSetId TEXT NOT NULL,
      indexNum INTEGER NOT NULL,
      sourceImageId TEXT NOT NULL,
      latestGeneratedImageId TEXT,
      latestJobId TEXT,
      reviewMark TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (sourceImageId) REFERENCES image_assets(id),
      FOREIGN KEY (latestGeneratedImageId) REFERENCES image_assets(id),
      FOREIGN KEY (latestJobId) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS video_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('kling','jimeng')),
      baseUrlEnv TEXT NOT NULL,
      apiKeyEnv TEXT NOT NULL,
      modelEnv TEXT NOT NULL,
      defaultModel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      defaultDurationSec INTEGER NOT NULL DEFAULT 5,
      defaultCostPerVideo REAL
    );

    CREATE TABLE IF NOT EXISTS video_prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompt TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'camera_motion',
      isBuiltin INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      shotSetId TEXT,
      shotId TEXT,
      sourceImageId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      templateId TEXT,
      prompt TEXT NOT NULL,
      durationSec INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'pending',
      providerTaskId TEXT,
      providerStatus TEXT,
      providerRawResponse TEXT,
      lastPolledAt TEXT,
      pollCount INTEGER DEFAULT 0,
      remoteVideoUrl TEXT,
      localVideoPath TEXT,
      filename TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 1,
      errorMessage TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE SET NULL,
      FOREIGN KEY (shotId) REFERENCES shots(id) ON DELETE SET NULL,
      FOREIGN KEY (sourceImageId) REFERENCES image_assets(id),
      FOREIGN KEY (providerId) REFERENCES video_providers(id),
      FOREIGN KEY (templateId) REFERENCES video_prompt_templates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON video_jobs(projectId);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_shot ON video_jobs(shotId);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);

    CREATE TABLE IF NOT EXISTS script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  const videoJobMigrations = [
    `ALTER TABLE video_jobs ADD COLUMN lastPolledAt TEXT`,
    `ALTER TABLE video_jobs ADD COLUMN pollCount INTEGER DEFAULT 0`,
  ];
  for (const sql of videoJobMigrations) {
    try { db.exec(sql); } catch { /* Column already exists */ }
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
