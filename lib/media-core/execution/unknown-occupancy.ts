import { ExecutionError, type ExecutionFacadeOptions, type InstanceFence } from './context.ts';

export const UNKNOWN_OCCUPANCY_POLICY = 'expired-unknown-v1';
interface Candidate {
  id: string; actorId: string; currentAttemptId: string; currentPermitId: string; requiredPoolsJson: string;
  instanceId: string; fence: number; leaseUntil: string; updatedAt: string;
}
interface Reservation { id: string; poolKey: string; state: string; operationId: string; actorId: string }

/** Detach scheduling occupancy only. Never changes a call outcome, budget hold or retry identity. */
export function releaseExpiredUnknownConcurrency(
  options: ExecutionFacadeOptions, instance: InstanceFence, idleMs: number,
): { operations: number; reservations: number } {
  const none = { operations: 0, reservations: 0 };
  if (options.maintenance()) return none;
  if (!Number.isSafeInteger(idleMs) || idleMs < 60_000) throw new ExecutionError('invalid_input', '未知并发清理期限至少为一分钟。');
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - idleMs).toISOString();
  const candidates = options.db.prepare(`
    SELECT o.id,o.actorId,o.currentAttemptId,o.currentPermitId,o.requiredPoolsJson,
      a.instanceId,a.fence,a.leaseUntil,a.updatedAt
    FROM execution_operations o JOIN execution_attempts a ON a.id=o.currentAttemptId
    WHERE o.status='unknown' AND a.operationId=o.id AND a.permitId=o.currentPermitId AND a.actorId=o.actorId
      AND a.submissionState='maybe_sent' AND a.terminalState IS NULL AND a.remoteId IS NULL
      AND a.leaseUntil<=? AND a.updatedAt<=?
      AND EXISTS (SELECT 1 FROM execution_reservations r WHERE r.permitId=o.currentPermitId AND r.kind='concurrency' AND r.state='held')
    ORDER BY a.updatedAt,o.id LIMIT 100
  `).all(cutoff, cutoff) as Candidate[];
  if (candidates.length === 0) return none;
  const verified = options.journal.verify({ repairTail: false });
  if (!verified.valid) throw new ExecutionError('execution_journal_unavailable', '未知并发清理要求完整执行证据。');
  const evidence = new Map<string, typeof verified.records>();
  for (const record of verified.records) {
    const list = evidence.get(record.attemptId) ?? []; list.push(record); evidence.set(record.attemptId, list);
  }
  const run = options.db.transaction(() => {
    const owner = options.db.prepare(`SELECT 1 FROM execution_instances
      WHERE instanceId=? AND fence=? AND deploymentId=? AND stoppedAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM execution_instances WHERE deploymentId=? AND fence>?)
    `).get(instance.instanceId, instance.fence, options.deploymentId, options.deploymentId, instance.fence);
    if (!owner) throw new ExecutionError('stale_fence', '未知并发清理实例已失效。');
    if (options.maintenance()) return none;
    let operations = 0; let reservations = 0;
    for (const candidate of candidates) {
      // Recheck after obtaining the write lock; a receipt/lease may have changed while verifying the journal.
      const current = options.db.prepare(`SELECT o.status,o.currentAttemptId,o.currentPermitId,
        a.submissionState,a.terminalState,a.remoteId,a.updatedAt,a.leaseUntil
        FROM execution_operations o JOIN execution_attempts a ON a.id=o.currentAttemptId WHERE o.id=?`).get(candidate.id) as Record<string, unknown> | undefined;
      if (!current || current.status !== 'unknown' || current.currentAttemptId !== candidate.currentAttemptId
        || current.currentPermitId !== candidate.currentPermitId || current.submissionState !== 'maybe_sent'
        || current.terminalState !== null || current.remoteId !== null || current.updatedAt !== candidate.updatedAt
        || current.leaseUntil !== candidate.leaseUntil) continue;
      const records = evidence.get(candidate.currentAttemptId) ?? [];
      const intent = records.find(r => r.eventType === 'submit_intent');
      const last = records.at(-1);
      if (!intent || !last || intent.operationId !== candidate.id || intent.permitId !== candidate.currentPermitId
        || intent.actorId !== candidate.actorId || last.operationId !== candidate.id || last.permitId !== candidate.currentPermitId
        || last.actorId !== candidate.actorId || last.remoteId || (last.terminalState && last.terminalState !== 'unknown')) continue;
      const unknownReceipt = last.eventType === 'receipt' && last.terminalState === 'unknown';
      // An intent without a receipt is eligible only after recovery by a newer fenced owner.
      const recoveredIntent = last.eventType === 'submit_intent' && candidate.fence < instance.fence && candidate.instanceId !== instance.instanceId;
      if (!unknownReceipt && !recoveredIntent) continue;
      const times = [candidate.updatedAt, candidate.leaseUntil, intent.at, last.at].map(Date.parse);
      if (times.some(t => !Number.isFinite(t)) || Math.max(...times) > now.getTime() - idleMs) continue;
      const rows = options.db.prepare("SELECT id,poolKey,state,operationId,actorId FROM execution_reservations WHERE permitId=? AND kind='concurrency' ORDER BY id")
        .all(candidate.currentPermitId) as Reservation[];
      let expectedPools: string[];
      try {
        const requiredPools: unknown = JSON.parse(candidate.requiredPoolsJson);
        if (!Array.isArray(requiredPools) || requiredPools.some(pool => typeof pool !== 'string')) continue;
        expectedPools = [...requiredPools, `actor:${candidate.actorId}:remote`].sort();
      }
      catch { continue; }
      if (JSON.stringify(rows.map(r => r.poolKey).sort()) !== JSON.stringify(expectedPools)
        || rows.some(r => r.operationId !== candidate.id || r.actorId !== candidate.actorId)) continue;
      const held = rows.filter(r => r.state === 'held');
      if (!held.length) continue;
      if (options.db.prepare('SELECT 1 FROM execution_unknown_occupancy_releases WHERE permitId=?').get(candidate.currentPermitId)) {
        throw new ExecutionError('occupancy_audit_conflict', '已释放名额出现重复占用，请核查恢复记录。');
      }
      const at = now.toISOString();
      options.db.prepare(`INSERT INTO execution_unknown_occupancy_releases
        (permitId,operationId,attemptId,actorId,policyVersion,idleMs,lastEvidenceAt,leaseUntil,
         releasedAt,instanceId,fence,previousInstanceId,previousFence,journalSeq,journalHash,reservationsJson)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        candidate.currentPermitId,candidate.id,candidate.currentAttemptId,candidate.actorId,UNKNOWN_OCCUPANCY_POLICY,idleMs,
        new Date(Math.max(...times)).toISOString(),candidate.leaseUntil,at,instance.instanceId,instance.fence,
        candidate.instanceId,candidate.fence,last.seq,last.hash,JSON.stringify(held),
      );
      for (const row of held) reservations += options.db.prepare(`UPDATE execution_reservations
        SET state='released',releasedAt=?,releaseReason=? WHERE id=? AND kind='concurrency' AND state='held'`)
        .run(at,UNKNOWN_OCCUPANCY_POLICY,row.id).changes;
      operations += 1;
    }
    return { operations, reservations };
  });
  return run.immediate();
}

/** One lifecycle-bound timer, plus a throttled admission check. No standalone worker or network calls. */
export function createUnknownOccupancyMaintenance(options: ExecutionFacadeOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: (InstanceFence & { signal: AbortSignal }) | undefined;
  let lastSweep = Number.NEGATIVE_INFINITY;
  function stop() {
    if (timer) clearInterval(timer); timer = undefined;
    context?.signal.removeEventListener('abort', stop); context = undefined;
  }
  function sweep() {
    const policy = options.unknownConcurrency;
    if (!policy || !context || context.signal.aborted) return;
    const now = (options.now?.() ?? new Date()).getTime();
    if (now - lastSweep < policy.sweepIntervalMs && now >= lastSweep) return;
    lastSweep = now;
    try { releaseExpiredUnknownConcurrency(options, context, policy.idleMs); }
    catch (error) {
      // A failed cleanup never changes the original evidence or bypasses normal admission gates.
      console.warn('[execution] unknown occupancy cleanup deferred:', error instanceof ExecutionError ? error.code : 'cleanup_failed');
    }
  }
  return {
    sweep, stop,
    start(next: InstanceFence & { signal: AbortSignal }) {
      stop();
      if (!options.unknownConcurrency || next.signal.aborted) return;
      const { idleMs, sweepIntervalMs } = options.unknownConcurrency;
      if (!Number.isSafeInteger(idleMs) || idleMs < 60_000 || !Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1_000) {
        throw new ExecutionError('invalid_input', '未知并发清理配置无效。');
      }
      context = next; lastSweep = Number.NEGATIVE_INFINITY;
      context.signal.addEventListener('abort', stop, { once: true });
      sweep(); timer = setInterval(sweep, sweepIntervalMs); timer.unref();
    },
  };
}