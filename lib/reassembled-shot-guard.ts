import type Database from 'better-sqlite3';

/** Persisted identity applies even when a generic queue entry point resumes a rework. */
export function isReassembledReworkJob(db: Database.Database, jobId: string, kind: 'generate_image' | 'generate_video'): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='final_edit_film_reworks'").get()
    && db.prepare('SELECT 1 FROM final_edit_film_reworks WHERE jobId=? AND kind=?').get(jobId, kind));
}

export const REASSEMBLED_SUBMIT_UNCERTAIN = '局部返工已尝试提交，结果尚不能确认，已停止自动重发以避免重复扣费。请核对供应商记录；需要重新生成时使用新的返工请求。';

/** Run before recovery/claim, without touching other projects or another scoped job. */
export function protectReassembledQueue(db: Database.Database, projectId: string, kind: 'generate_image' | 'generate_video', jobId?: string, recoverRunning = true): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='final_edit_film_reworks'").get()) return;
  const table = kind === 'generate_image' ? 'jobs' : 'video_jobs';
  const states = recoverRunning ? "'pending','retrying','running'" : "'pending','retrying'";
  db.prepare(`UPDATE ${table} SET status='failed', finishedAt=datetime('now'), errorMessage=?
    WHERE projectId=? AND (? IS NULL OR id=?) AND status IN (${states})
    AND (attempt > 0 OR status='running') AND COALESCE(TRIM(providerTaskId),'')=''
    AND EXISTS (SELECT 1 FROM final_edit_film_reworks r WHERE r.jobId=${table}.id AND r.kind=?)`)
    .run(REASSEMBLED_SUBMIT_UNCERTAIN, projectId, jobId ?? null, jobId ?? null, kind);
  // Image providers do not all implement resumable submission in runQueue.
  // The dedicated resume endpoint can query/download these existing identities.
  if (kind === 'generate_image') db.prepare(`UPDATE jobs SET status='needs_check', finishedAt=datetime('now'),
    errorMessage='已有远端图片任务，请补抓结果；不会重新提交。'
    WHERE projectId=? AND (? IS NULL OR id=?) AND status IN (${states})
    AND COALESCE(TRIM(providerTaskId),'')<>''
    AND EXISTS (SELECT 1 FROM final_edit_film_reworks r WHERE r.jobId=jobs.id AND r.kind=?)`)
    .run(projectId, jobId ?? null, jobId ?? null, kind);
}

// Also used by older isolated domain tests which intentionally omit final-edit tables.
export function isReassembledShotSet(db: Database.Database, shotSetId: string): boolean {
  return ['final_edit_film_bindings', 'final_edit_film_production_items'].some(table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    && db.prepare(`SELECT 1 FROM ${table} WHERE shotSetId=?`).get(shotSetId)));
}

/** Native mixcut owns an adopted draft; new image/video candidates do not alter its timeline.
 * Keep the broader identity guard for deleting a shot set and its historical media.
 */
export function requiresReassembledUpstreamRework(db: Database.Database, shotSetId: string): boolean {
  if (!isReassembledShotSet(db, shotSetId)) return false;
  const hasBindings = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='final_edit_film_bindings'").get();
  if (!hasBindings) return true;
  const bindings = db.prepare(`SELECT v.timelineJson FROM final_edit_film_bindings b
    LEFT JOIN final_edit_variants v ON v.id=b.variantId WHERE b.shotSetId=?`).all(shotSetId) as Array<{ timelineJson: string | null }>;
  return bindings.length === 0 || bindings.some(row => !row.timelineJson || JSON.parse(row.timelineJson).importedFilmEditor !== 'mixcut');
}

export function requiresReassembledImageRework(db: Database.Database, jobId: string): boolean {
  if (!isReassembledImageJob(db, jobId)) return false;
  const owners = new Set<string>();
  const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (exists('final_edit_film_production_items')) {
    for (const row of db.prepare("SELECT p.shotSetId FROM final_edit_film_production_items p, json_each(p.registryJson, '$.jobs') j WHERE j.value=?").all(jobId) as Array<{ shotSetId: string }>) owners.add(row.shotSetId);
  }
  if (exists('final_edit_film_reworks') && exists('final_edit_film_bindings')) {
    for (const row of db.prepare('SELECT b.shotSetId FROM final_edit_film_reworks r JOIN final_edit_film_bindings b ON b.id=r.bindingId WHERE r.jobId=?').all(jobId) as Array<{ shotSetId: string }>) owners.add(row.shotSetId);
  }
  return owners.size === 0 || [...owners].some(id => requiresReassembledUpstreamRework(db, id));
}
/** Completed external receipts and P2 candidates cannot use the unversioned redo route. */
export function isReassembledImageJob(db: Database.Database, jobId: string): boolean {
  const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return Boolean(
    (exists('final_edit_film_production_items') && db.prepare("SELECT 1 FROM final_edit_film_production_items p, json_each(p.registryJson, '$.jobs') j WHERE j.value=? LIMIT 1").get(jobId))
    || (exists('final_edit_film_reworks') && db.prepare("SELECT 1 FROM final_edit_film_reworks WHERE jobId=? AND kind='generate_image'").get(jobId)),
  );
}
export const REASSEMBLED_REWORK_REQUIRED = '该分镜组属于实拍重组制作。制作中请查看同步结果；接管成片后从第五步选择镜头进入局部返工，旧入口不能覆盖当前选择。';
