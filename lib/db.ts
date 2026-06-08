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
  }
  return db;
}

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
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
