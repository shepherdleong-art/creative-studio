import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schemaUpgradeRuntimePaths } from '../../lib/schema-upgrade/runtime.ts';
import { readRuntimeConfig } from '../../lib/team-service/config.ts';
import { checkExecutionReadiness } from '../../lib/media-core/execution/readiness.ts';
import { applyPoolChanges, previewPoolChanges, readPoolAdminState } from '../../lib/team-service/pools.ts';

/**
 * 受控资源池配置 CLI（R01）。
 *
 * 用法（在 release 包内用自带 Node，并以 app.env 启动）：
 *   node --env-file=<deploymentRoot>\service\app.env service/configure-pools.mjs --file pools.json [--preview]
 *   node --env-file=<deploymentRoot>\service\app.env service/configure-pools.mjs --show
 *
 * 合同：
 * - CLI 不接受命令行明文 Key；媒体共享池只按供应商 ID 解析服务端凭据指纹；
 * - 预览与应用使用同一校验逻辑，应用前必须通过共享升级 gate；
 * - 输出只含池键、容量、版本与修复原因，不含凭据或签名。
 */

const CLI_VIEWER = { userId: 'local-admin-cli', role: 'admin' };

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}

function parseInput(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`无法读取资源池配置：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.changes)) {
    fail('资源池配置必须是 { schemaVersion: 1, changes: [...] }');
  }
  return parsed.changes;
}

async function openDatabase() {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') fail('资源池配置必须显式使用 server 数据根配置（app.env）');
  const dbPath = path.join(config.dataRoot, 'data', 'workbench.db');
  if (!fs.existsSync(dbPath)) fail('数据根尚未初始化业务数据库；请先启动一次服务并完成迁移');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

try {
  const showOnly = process.argv.includes('--show');
  const previewOnly = process.argv.includes('--preview');
  const file = argument('--file');
  if (!showOnly && !file) {
    fail('用法：configure-pools.mjs [--show | --file <pools.json>] [--preview]（需 node --env-file=<app.env>）');
  }
  const db = await openDatabase();
  try {
    const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(readRuntimeConfig().dataRoot) });
    if (!readiness.available) fail(`共享执行设施未就绪：${readiness.code} ${readiness.message}`);
    if (showOnly) {
      process.stdout.write(`${JSON.stringify(readPoolAdminState(db, CLI_VIEWER))}\n`);
    } else {
      const changes = parseInput(file);
      if (previewOnly) {
        process.stdout.write(`${JSON.stringify({ preview: previewPoolChanges(db, CLI_VIEWER, changes) })}\n`);
      } else {
        const result = applyPoolChanges(db, CLI_VIEWER, changes);
        process.stdout.write(`${JSON.stringify({ applied: result.applied, ready: result.requirements.every((item) => item.status === 'ready' || item.status === 'provider_disabled') })}\n`);
      }
    }
  } finally {
    db.close();
  }
} catch (error) {
  process.stderr.write(`资源池配置失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
