import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const PATH_COLUMNS = [
  { table: 'image_assets', column: 'path' },
  { table: 'image_assets', column: 'originalPath' },
  { table: 'image_assets', column: 'processedPath' },
  { table: 'video_jobs', column: 'localVideoPath' },
];

function isDirectory(value) {
  return fs.existsSync(value) && fs.statSync(value).isDirectory();
}

function directoryIsEmpty(value) {
  return !fs.existsSync(value) || (fs.statSync(value).isDirectory() && fs.readdirSync(value).length === 0);
}

function relativeInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function copyBusinessStorage(sourceStorage, destinationStorage) {
  fs.mkdirSync(destinationStorage, { recursive: true });
  if (!isDirectory(sourceStorage)) return;

  fs.cpSync(sourceStorage, destinationStorage, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter(source) {
      const relative = path.relative(sourceStorage, source);
      if (!relative) return true;
      const topLevel = relative.split(path.sep)[0].toLocaleLowerCase('en-US');
      return topLevel !== 'logs' && topLevel !== 'run';
    },
  });
}

function countFiles(root) {
  if (!isDirectory(root)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(absolute).size;
      }
    }
  }
  return { files, bytes };
}

function tableColumns(db, table) {
  const exists = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
  if (!exists) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name)));
}

function clearMigratedJobLogs(db) {
  const exists = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'job_logs'
  `).get();
  if (!exists) return 0;
  return Number(db.prepare(`DELETE FROM job_logs`).run().changes);
}

function rebaseManagedMediaPaths(db, sourceStorage, verificationStorage, destinationStorage) {
  const details = [];
  let updated = 0;
  let missing = 0;

  const run = db.transaction(() => {
    for (const target of PATH_COLUMNS) {
      const columns = tableColumns(db, target.table);
      if (!columns.has(target.column)) continue;

      const rows = db.prepare(`
        SELECT rowid AS rowId, "${target.column}" AS storedPath
        FROM "${target.table}"
        WHERE "${target.column}" IS NOT NULL AND trim("${target.column}") != ''
      `).all();
      let columnUpdated = 0;
      let columnMissing = 0;
      const update = db.prepare(`
        UPDATE "${target.table}" SET "${target.column}" = ? WHERE rowid = ?
      `);

      for (const row of rows) {
        const storedPath = String(row.storedPath);
        if (!path.isAbsolute(storedPath)) continue;
        const relative = relativeInside(sourceStorage, storedPath);
        if (!relative) continue;
        const verificationPath = path.resolve(verificationStorage, relative);
        if (!fs.existsSync(verificationPath) || !fs.statSync(verificationPath).isFile()) {
          columnMissing += 1;
          continue;
        }
        const relocatedPath = path.resolve(destinationStorage, relative);
        update.run(relocatedPath, row.rowId);
        columnUpdated += 1;
      }

      updated += columnUpdated;
      missing += columnMissing;
      details.push({ table: target.table, column: target.column, updated: columnUpdated, missing: columnMissing });
    }
  });

  run();
  return { updated, missing, details };
}

function removeEmptyDirectory(directory) {
  if (fs.existsSync(directory)) fs.rmdirSync(directory);
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

export async function migratePortableData({ oldRoot, newRoot }) {
  const sourceRoot = path.resolve(oldRoot);
  const destinationRoot = path.resolve(newRoot);
  const sourceDbPath = path.join(sourceRoot, 'data', 'workbench.db');
  const sourceStorage = path.join(sourceRoot, 'storage');
  const destinationData = path.join(destinationRoot, 'data');
  const destinationStorage = path.join(destinationRoot, 'storage');

  if (sourceRoot.localeCompare(destinationRoot, undefined, { sensitivity: 'accent' }) === 0) {
    throw new Error('旧版目录和新版目录不能相同。');
  }
  if (!isDirectory(sourceRoot)) throw new Error(`旧版目录不存在：${sourceRoot}`);
  if (!isDirectory(destinationRoot)) throw new Error(`新版目录不存在：${destinationRoot}`);
  if (!fs.existsSync(sourceDbPath) || !fs.statSync(sourceDbPath).isFile()) {
    throw new Error('旧版目录中没有 data\\workbench.db，请重新选择旧版免安装版根目录。');
  }
  if (!directoryIsEmpty(destinationData) || !directoryIsEmpty(destinationStorage)) {
    throw new Error('新版目录已有 data 或 storage 内容。为避免覆盖，请换一份从未启动过的 0.6.0 免安装包再迁移。');
  }

  const startedAt = new Date();
  const stagingRoot = path.join(destinationRoot, `.migration-staging-${process.pid}-${Date.now()}`);
  const stagingData = path.join(stagingRoot, 'data');
  const stagingStorage = path.join(stagingRoot, 'storage');
  const stagingDbPath = path.join(stagingData, 'workbench.db');
  let publishedData = false;
  let publishedStorage = false;

  try {
    fs.mkdirSync(stagingData, { recursive: true });
    copyBusinessStorage(sourceStorage, stagingStorage);

    const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    try {
      await sourceDb.backup(stagingDbPath);
    } finally {
      sourceDb.close();
    }

    const migratedDb = new Database(stagingDbPath);
    let pathResult;
    let jobLogsDeleted = 0;
    try {
      if (migratedDb.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('SQLite quick_check 未通过，拒绝发布迁移结果。');
      }
      jobLogsDeleted = clearMigratedJobLogs(migratedDb);
      pathResult = rebaseManagedMediaPaths(migratedDb, sourceStorage, stagingStorage, destinationStorage);
      // DELETE 后重写副本，避免旧日志文本只是在 SQLite freelist 中不可见但仍占空间。
      migratedDb.exec('VACUUM');
      if (migratedDb.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('媒体路径修复后的 SQLite quick_check 未通过，拒绝发布迁移结果。');
      }
    } finally {
      migratedDb.close();
    }

    removeEmptyDirectory(destinationData);
    removeEmptyDirectory(destinationStorage);
    fs.renameSync(stagingData, destinationData);
    publishedData = true;
    fs.renameSync(stagingStorage, destinationStorage);
    publishedStorage = true;
    fs.rmSync(stagingRoot, { recursive: true, force: true });

    const storage = countFiles(destinationStorage);
    const report = {
      schemaVersion: 1,
      mode: 'creative-studio-portable-data-migration',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      sourceRoot,
      destinationRoot,
      database: {
        source: 'data/workbench.db',
        destination: 'data/workbench.db',
        method: 'sqlite-online-backup',
        quickCheck: 'ok',
        jobLogsDeleted,
        vacuumed: true,
      },
      storage: {
        files: storage.files,
        bytes: storage.bytes,
        excludedTopLevelDirectories: ['logs', 'run'],
      },
      mediaPaths: pathResult,
    };
    const reportPath = path.join(destinationRoot, `迁移报告-${timestampForFilename()}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
    return { ...report, reportPath };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    if (publishedStorage) fs.rmSync(destinationStorage, { recursive: true, force: true });
    if (publishedData) fs.rmSync(destinationData, { recursive: true, force: true });
    throw error;
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const oldRoot = readArg('--old-root');
  const newRoot = readArg('--new-root');
  if (!oldRoot || !newRoot) {
    throw new Error('用法：migrate-portable-data.mjs --old-root <旧版目录> --new-root <新版目录>');
  }
  const result = await migratePortableData({ oldRoot, newRoot });
  console.log(`迁移完成：${result.storage.files} 个素材文件，修复 ${result.mediaPaths.updated} 条媒体路径。`);
  if (result.mediaPaths.missing > 0) {
    console.warn(`有 ${result.mediaPaths.missing} 条旧媒体记录找不到对应文件，详见迁移报告。`);
  }
  console.log(`迁移报告：${result.reportPath}`);
}

const invokedAsScript = process.argv[1]
  && fileURLToPath(import.meta.url).localeCompare(path.resolve(process.argv[1]), undefined, { sensitivity: 'accent' }) === 0;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
