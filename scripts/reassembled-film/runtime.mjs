// Persistent local orchestration. Provider calls are injected for offline testing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OPENINGS = ['carton-explosion', 'bare-shell-renovation', 'giant-hand-place', 'magic-growth'];
export const PRICES = { 'qiniuyun/gpt-image-2-medium': .25, 'doubao-seedream-5-0-pro-image': .61, 'kling-2.5': 1.52, 'doubao-seedance-2-0-260128': 2, 'doubao-seedance-2-5-260628': 7.6 };
export const now = () => new Date().toISOString();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function local(project, relative) {
  const root = path.resolve(project), target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('Path outside project');
  // Existing ancestors must not escape through junctions/symlinks either.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(root), real = fs.realpathSync(ancestor);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Linked path outside project');
  return target;
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  // Windows readers/antivirus can briefly deny replacing an open destination.
  // Keep the atomic replacement; never delete the durable ledger first.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); break; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}
export function acquireLock(project) {
  const file = local(project, 'review/generation.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Never auto-steal PID locks: PID reuse / an inaccessible process is ambiguous.
  const fd = fs.openSync(file, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() }));
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}
export function validateJob(job) {
  if (!job || !/^[a-zA-Z0-9_-]+$/.test(job.id) || !['image', 'video'].includes(job.kind)) throw new Error('Invalid job id/kind');
  for (const key of ['input', 'prompt', 'output', 'model', 'providerId']) if (typeof job[key] !== 'string' || !job[key]) throw new Error(`Missing ${key}`);
  if (job.references && (!Array.isArray(job.references) || job.references.some(v => typeof v !== 'string'))) throw new Error('Invalid references');
  if (job.kind === 'video' && !(Number.isFinite(job.durationSec) && job.durationSec > 0)) throw new Error('Invalid video duration');
}
export const poolFor = job => job.kind === 'image' ? 'image' : job.model.startsWith('doubao-seedance-') ? 'seedance' : 'video';

export function enqueue(project, input) {
  if (!Array.isArray(input) || !input.length) throw new Error('Expected nonempty array of jobs or {job, dependsOn, requiresReview} entries');
  const entries = input.map(item => {
    const entry = item.job ? item : { job: item };
    validateJob(entry.job);
    for (const field of ['dependsOn', 'requiresReview']) if (entry[field] && (!Array.isArray(entry[field]) || entry[field].some(id => typeof id !== 'string'))) throw new Error(`Invalid ${field}`);
    if (entry.openingEffectId && !OPENINGS.includes(entry.openingEffectId)) throw new Error('Opening must use one of the four approved effects');
    const promptHash = hashFile(local(project, entry.job.prompt));
    for (const f of [entry.job.input, entry.job.output, ...(entry.job.references || [])]) local(project, f);
    return { ...entry, promptHash, enqueuedAt: now() };
  });
  // Writers never touch the worker's ledger or lock. A unique, atomic inbox packet.
  const file = local(project, `queue/inbox/${crypto.randomUUID()}.json`);
  writeJson(file, entries);
  return file;
}
export function readInbox(project) {
  const dir = local(project, 'queue/inbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().flatMap(f => readJson(path.join(dir, f)));
}
export function approve(project, id, reviewer, note) {
  if (!reviewer?.trim() || !note?.trim()) throw new Error('Reviewer and visual-review note required');
  const record = readJson(local(project, 'review/generation-ledger.json'), {})[id];
  if (record?.status !== 'downloaded') throw new Error('Review requires a downloaded task');
  const outputHash = hashFile(local(project, record.job.output));
  if (record.outputHash && record.outputHash !== outputHash) throw new Error('Downloaded output changed');
  const review = { id, outputHash, reviewer, note, approvedAt: now(), legacyOutput: !record.outputHash };
  writeJson(local(project, `queue/reviews/${id}.json`), review);
  return review;
}

export class FilmQueue {
  constructor({ project, adapter, concurrency = 50, pools = { image: 50, video: 50, seedance: 50 }, cap = 40, pollMs = 10000, timeoutMs = 1800000, legacy = false, log = console.log }) {
    this.project = path.resolve(project); this.adapter = adapter; this.concurrency = concurrency;
    this.pools = pools; this.cap = cap; this.pollMs = pollMs; this.timeoutMs = timeoutMs; this.legacy = legacy; this.log = log;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('Concurrency must be 1–50');
    for (const key of ['image', 'video', 'seedance']) if (!Number.isInteger(pools[key]) || pools[key] < 1 || pools[key] > 50) throw new Error('Pool limits must be 1–50');
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('Invalid budget cap');
    this.ledgerPath = local(project, 'review/generation-ledger.json');
    this.ledger = readJson(this.ledgerPath, {}); this.entries = new Map(); this.active = new Map(); this.done = new Set(); this.errors = new Map(); this.states = {};
  }
  save() { writeJson(this.ledgerPath, this.ledger); }
  add(entries) {
    for (const item of entries) {
      const entry = item.job ? item : { job: item };
      validateJob(entry.job);
      if (entry.openingEffectId && !OPENINGS.includes(entry.openingEffectId)) throw new Error('Opening must use one of the four approved effects');
      for (const field of ['dependsOn', 'requiresReview']) if (entry[field] && (!Array.isArray(entry[field]) || entry[field].some(id => !/^[a-zA-Z0-9_-]+$/.test(id)))) throw new Error(`Invalid ${field}`);
      const old = this.entries.get(entry.job.id);
      const identity = e => canonical({ ...e, enqueuedAt: undefined });
      if (old && identity(old) !== identity(entry)) throw new Error(`Changed queue entry ${entry.job.id}; use a versioned ID`);
      if (!old) this.entries.set(entry.job.id, entry);
    }
    const outputs = new Map();
    for (const job of [...Object.values(this.ledger).map(r => r.job), ...[...this.entries.values()].map(e => e.job)]) {
      const output = local(this.project, job.output);
      if (outputs.has(output) && outputs.get(output) !== job.id) throw new Error(`Two jobs target ${job.output}`);
      outputs.set(output, job.id);
    }
    this.outputs = outputs;
    const visit = (id, stack = new Set(), seen = new Set()) => {
      if (stack.has(id)) throw new Error(`Dependency cycle: ${id}`);
      if (seen.has(id)) return;
      seen.add(id); stack.add(id);
      const entry = this.entries.get(id);
      if (entry) for (const dep of this.dependencies(entry)) visit(dep, stack, seen);
      stack.delete(id);
    };
    for (const id of this.entries.keys()) visit(id);
  }
  dependencies(entry) {
    if (this.legacy) return [];
    const files = [entry.job.input, ...(entry.job.references || [])];
    const inferred = files.map(f => this.outputs.get(local(this.project, f))).filter(Boolean);
    return [...new Set([...(entry.dependsOn || []), ...(entry.requiresReview || []), ...inferred])];
  }
  approved(id) {
    const r = this.ledger[id];
    const proof = readJson(local(this.project, `queue/reviews/${id}.json`), null);
    return r?.status === 'downloaded' && proof?.id === id && proof?.outputHash === hashFile(local(this.project, r.job.output));
  }
  gate(entry) {
    const r = this.ledger[entry.job.id];
    // Already paid remote work can always finish, even if upstream approval is later withdrawn.
    if (r) return null;
    for (const id of this.dependencies(entry)) {
      if (this.ledger[id]?.status !== 'downloaded') return `waiting_dependency:${id}`;
      if (!this.approved(id)) return `waiting_visual_review:${id}`;
    }
    return null;
  }
  fingerprint(job) {
    const files = [job.prompt, job.input, ...(job.references || [])];
    return crypto.createHash('sha256').update(canonical({ job, files: files.map(f => [f, hashFile(local(this.project, f))]) })).digest('hex');
  }
  async execute(entry) {
    const job = entry.job, output = local(this.project, job.output);
    let record = this.ledger[job.id];
    if (record && canonical(record.job) !== canonical(job)) throw new Error('Changed job: use a new version ID');
    if (record?.status === 'downloaded') {
      if (!fs.existsSync(output) || fs.statSync(output).size !== record.bytes || (record.outputHash && hashFile(output) !== record.outputHash)) throw new Error('Completed output missing or changed; do not resubmit');
      if (record.fingerprint && this.fingerprint(job) !== record.fingerprint) throw new Error('Completed task inputs changed; use a versioned ID');
      this.log(`${job.id}: reuse${record.outputHash ? '' : ' (legacy size check)'}`);
      return;
    }
    const fingerprint = this.fingerprint(job);
    if (entry.promptHash && hashFile(local(this.project, job.prompt)) !== entry.promptHash) throw new Error('Prompt changed after enqueue; use a versioned ID');
    if (record?.fingerprint && record.fingerprint !== fingerprint) throw new Error('Input content changed; refusing resume');
    // A crash after writing the output but before committing the final ledger is recoverable.
    if (record?.pendingOutput && fs.existsSync(output) && hashFile(output) === record.pendingOutput.hash) {
      Object.assign(record, { outputHash: record.pendingOutput.hash, bytes: fs.statSync(output).size, status: 'downloaded', completedAt: now() });
      delete record.pendingOutput; this.save(); return;
    }
    if (record && !record.taskId) throw new Error('Previous submission has no resumable ID; inspect before retrying');
    if (fs.existsSync(output)) throw new Error('Output already exists; refusing overwrite');
    if (record?.remoteFailed) throw new Error('Remote task failed; a reviewed, versioned rework is required');
    let mediaUrl;
    if (!record) {
      const estimate = PRICES[job.model];
      const total = Object.values(this.ledger).reduce((sum, r) => sum + r.estimateYuan, 0);
      if (!Number.isFinite(total) || estimate === undefined || total + estimate > this.cap + 1e-8) throw new Error('Unknown estimate or generation budget cap reached');
      record = this.ledger[job.id] = { job, fingerprint, estimateYuan: estimate, enqueuedAt: entry.enqueuedAt || now(), readyAt: now(), startedAt: now(), status: 'submitting' };
      this.save(); // Reserve budget and mark ambiguous submission before any await / paid request.
      this.log(`${job.id}: submitting ${job.model}`);
      const submitted = await this.adapter.submit(job);
      record.taskId = submitted.taskId;
      record.transports = submitted.transports;
      record.submittedAt = now(); record.status = 'submitted'; this.save();
      // URLs can contain credentials; never persist them in the ledger.
      mediaUrl = submitted.mediaUrl;
    }
    const deadline = Date.now() + this.timeoutMs;
    while (!mediaUrl && Date.now() < deadline) {
      if (!record.taskId) throw new Error('No task ID or media URL');
      await sleep(this.pollMs);
      const r = await this.adapter.poll(job, record.taskId);
      record.pollCount = (record.pollCount || 0) + 1; record.lastPolledAt = now();
      if (r.status === 'failed') { record.remoteFailed = true; this.save(); throw new Error(r.error || 'Remote task failed'); }
      if (r.status === 'succeeded') mediaUrl = r.mediaUrl;
      record.status = r.status; this.save();
    }
    if (!mediaUrl) throw new Error('Polling time limit reached; resume with stored task ID');
    record.remoteSucceededAt = now(); record.downloadStartedAt = now(); this.save();
    const result = await this.adapter.download(job, mediaUrl);
    const hash = crypto.createHash('sha256').update(result.buffer).digest('hex');
    record.pendingOutput = { hash }; if (result.dimensions) record.dimensions = result.dimensions; this.save();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // Commit by hard link: cannot overwrite an existing output, even in a race.
    const tmp = `${output}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, result.buffer);
    try { fs.linkSync(tmp, output); } finally { fs.unlinkSync(tmp); }
    Object.assign(record, { status: 'downloaded', completedAt: now(), bytes: result.buffer.length, outputHash: hash });
    delete record.pendingOutput; delete record.error; this.save(); this.log(`${job.id}: downloaded`);
  }
  tick(entries = []) {
    this.add(entries);
    for (const [id, entry] of this.entries) {
      if (this.done.has(id) || this.errors.has(id) || this.active.has(id)) continue;
      let blocked;
      try { blocked = this.gate(entry); } catch (e) { this.errors.set(id, e.message); continue; }
      if (blocked) { this.states[id] = blocked; continue; }
      const pool = poolFor(entry.job);
      const used = [...this.active.values()].filter(a => a.pool === pool).length;
      if (this.active.size >= this.concurrency || used >= this.pools[pool]) { this.states[id] = 'waiting_slot'; continue; }
      this.states[id] = 'running';
      const promise = this.execute(entry).then(() => { this.done.add(id); this.states[id] = 'downloaded'; }).catch(e => {
        // Provider adapter sanitizes its errors. No raw request/URL logging here.
        this.errors.set(id, e.message); this.states[id] = 'attention';
        const r = this.ledger[id];
        if (r && r.status !== 'downloaded') { r.status = 'attention'; r.error = e.message; this.save(); }
        this.log(`${id}: ${e.message}`);
      }).finally(() => this.active.delete(id));
      this.active.set(id, { pool, promise });
    }
    return this.snapshot();
  }
  snapshot() {
    return { updatedAt: now(), active: this.active.size, completed: this.done.size, states: this.states, errors: Object.fromEntries(this.errors), estimateYuan: Number(Object.values(this.ledger).reduce((s, r) => s + r.estimateYuan, 0).toFixed(2)) };
  }
  async drain(entries) {
    this.add(entries);
    for (;;) {
      this.tick();
      if (!this.active.size) break;
      await Promise.race([...this.active.values()].map(a => a.promise));
    }
    return this.snapshot();
  }
}
