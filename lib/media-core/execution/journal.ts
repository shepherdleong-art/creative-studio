import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../../data-root.ts';
import { ExecutionError, type ExecutionJournal, type ExecutionJournalRecord } from './context.ts';

type JournalInput = Parameters<ExecutionJournal['appendIntent']>[0];
type ReceiptInput = Parameters<ExecutionJournal['appendReceipt']>[0];

export interface FileExecutionJournal extends ExecutionJournal { readonly directory: string }

function hashRecord(record: Omit<ExecutionJournalRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function identity(input: JournalInput | ReceiptInput) {
  return {
    operationId: input.operationId,
    attemptId: input.attemptId,
    permitId: input.permitId,
    actorId: input.actorId,
    module: input.module,
    step: input.step,
    inputHash: input.inputHash,
    requestHash: input.requestHash as string | undefined,
    transportSeq: input.transportSeq,
    requiredPools: [...input.requiredPools],
    policyVersion: input.policyVersion,
    accountingPeriod: input.accountingPeriod,
    currency: input.currency,
    reservedMinor: input.reservedMinor,
  };
}

function segmentNames(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^\d{6}\.jsonl$/.test(name)).sort();
}

function read(directory: string, deploymentId: string, repairTail: boolean): {
  valid: boolean;
  records: ExecutionJournalRecord[];
} {
  const names = segmentNames(directory);
  const records: ExecutionJournalRecord[] = [];
  let expectedSeq = 1;
  let previousHash: string | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const filePath = path.join(directory, name);
    let text = fs.readFileSync(filePath, 'utf8');
    if (!text.endsWith('\n')) {
      if (!repairTail || index !== names.length - 1) return { valid: false, records: [] };
      const copy = path.join(directory, `${name}.tail-${randomUUID()}`);
      fs.copyFileSync(filePath, copy);
      const newline = text.lastIndexOf('\n');
      const prefixLength = newline < 0 ? 0 : Buffer.byteLength(text.slice(0, newline + 1), 'utf8');
      const fd = fs.openSync(filePath, 'r+', 0o600);
      try {
        fs.ftruncateSync(fd, prefixLength);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      text = fs.readFileSync(filePath, 'utf8');
    }
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as ExecutionJournalRecord;
        const { hash, ...unsigned } = record;
        if (record.schemaVersion !== 1 || record.deploymentId !== deploymentId
          || record.seq !== expectedSeq || record.prevHash !== previousHash
          || !hash || hashRecord(unsigned) !== hash
          || !['submit_intent', 'receipt'].includes(record.eventType)) {
          return { valid: false, records: [] };
        }
        records.push(record);
        expectedSeq += 1;
        previousHash = hash;
      } catch {
        return { valid: false, records: [] };
      }
    }
  }
  return { valid: true, records };
}

function syncDirectory(directory: string, fsync: (fd: number) => void): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fsync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Windows 不支持目录 fsync；文件本身的 fsync 仍是强制屏障。
  }
}

export function createExecutionJournal(options: {
  deploymentId: string;
  directory?: string;
  maxSegmentBytes?: number;
  now?: () => Date;
  fsync?: (fd: number) => void;
}): FileExecutionJournal {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(options.deploymentId) || options.deploymentId.includes('..')) {
    throw new ExecutionError('invalid_journal_deployment', 'execution journal deploymentId 无效。');
  }
  const directory = options.directory ?? path.join(dataRoot(), 'storage', 'execution-journal', options.deploymentId);
  const maxSegmentBytes = options.maxSegmentBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 256) {
    throw new ExecutionError('invalid_journal_configuration', 'journal segment 大小无效。');
  }
  const now = options.now ?? (() => new Date());
  const fsync = options.fsync ?? fs.fsyncSync;

  function append(eventType: 'submit_intent' | 'receipt', input: JournalInput | ReceiptInput): ExecutionJournalRecord {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const state = read(directory, options.deploymentId, true);
    if (!state.valid) throw new ExecutionError('execution_journal_unavailable', 'execution journal 校验失败，拒绝追加。');
    const previous = state.records.at(-1);
    const receipt = eventType === 'receipt' ? input as ReceiptInput : null;
    const unsigned: Omit<ExecutionJournalRecord, 'hash'> = {
      schemaVersion: 1,
      deploymentId: options.deploymentId,
      seq: (previous?.seq ?? 0) + 1,
      prevHash: previous?.hash ?? null,
      eventType,
      at: input.at ?? now().toISOString(),
      ...identity(input),
      costState: input.costState as ExecutionJournalRecord['costState'],
      ...(receipt ? {
        remoteId: receipt.remoteId,
        resultRef: receipt.resultRef,
        terminalState: receipt.terminalState,
        actualCost: receipt.actualCost,
        costState: receipt.costState,
        errorCode: receipt.errorCode,
        reconciliationSource: receipt.reconciliationSource,
      } : {}),
    };
    const record: ExecutionJournalRecord = { ...unsigned, hash: hashRecord(unsigned) };
    const line = `${JSON.stringify(record)}\n`;
    let names = segmentNames(directory);
    let name = names.at(-1);
    if (!name) name = '000001.jsonl';
    let filePath = path.join(directory, name);
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    let newSegment = !fs.existsSync(filePath);
    if (size > 0 && size + Buffer.byteLength(line) > maxSegmentBytes) {
      name = `${String(Number(name.slice(0, 6)) + 1).padStart(6, '0')}.jsonl`;
      filePath = path.join(directory, name);
      newSegment = true;
    }
    const fd = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.writeFileSync(fd, line, { encoding: 'utf8' });
      fsync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (newSegment) syncDirectory(directory, fsync);
    names = segmentNames(directory);
    return record;
  }

  return {
    directory,
    appendIntent(input) { return append('submit_intent', input); },
    appendReceipt(input) { return append('receipt', input); },
    verify(verifyOptions) { return read(directory, options.deploymentId, verifyOptions?.repairTail ?? false); },
    scan() {
      const result = read(directory, options.deploymentId, true);
      if (!result.valid) throw new ExecutionError('execution_journal_unavailable', 'execution journal 校验失败。');
      return result.records;
    },
  };
}
