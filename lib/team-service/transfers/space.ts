import fs from 'node:fs';
import path from 'node:path';
import { TransferError } from './errors.ts';

export const TEAM_TRANSFER_STORAGE_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;

export interface TeamTransferSpaceReservation {
  release(): Promise<void>;
}

export interface TeamTransferSpace {
  probe(requiredBytes: number): Promise<void>;
  reserve(requiredBytes: number): Promise<TeamTransferSpaceReservation>;
}

type Statfs = (directory: string) => Promise<{ bavail: number; bsize: number }>;

async function defaultStatfs(directory: string): Promise<{ bavail: number; bsize: number }> {
  const stat = await fs.promises.statfs(directory);
  return { bavail: stat.bavail, bsize: stat.bsize };
}

export function createTeamTransferSpace(options: {
  storageRoot: string;
  safetyMarginBytes?: number;
  statfs?: Statfs;
}): TeamTransferSpace {
  const storageRoot = path.resolve(options.storageRoot);
  const safetyMarginBytes = options.safetyMarginBytes ?? TEAM_TRANSFER_STORAGE_SAFETY_MARGIN_BYTES;
  const statfs = options.statfs ?? defaultStatfs;
  let reservedBytes = 0;

  async function availableAfterReservations(requiredBytes: number): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0
      || !Number.isSafeInteger(safetyMarginBytes) || safetyMarginBytes < 0) {
      throw new TransferError('invalid_input', '空间预检字节数无效。');
    }
    await fs.promises.mkdir(storageRoot, { recursive: true });
    let availableBytes: number;
    try {
      const stat = await statfs(storageRoot);
      availableBytes = stat.bavail * stat.bsize;
    } catch (error) {
      if (error instanceof TransferError) throw error;
      throw new TransferError('insufficient_storage', '无法确认项目盘剩余空间，已暂停新的上传写入。');
    }
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes + reservedBytes + safetyMarginBytes) {
      throw new TransferError('insufficient_storage', '项目盘剩余空间不足以上传并保留安全余量，已暂停新的上传写入。');
    }
  }

  return {
    probe: availableAfterReservations,
    async reserve(requiredBytes) {
      await availableAfterReservations(requiredBytes);
      reservedBytes += requiredBytes;
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          reservedBytes = Math.max(0, reservedBytes - requiredBytes);
        },
      };
    },
  };
}

const SPACE_KEY = Symbol.for('creative-studio.team-transfer-space');
type SpaceRegistry = Map<string, TeamTransferSpace>;

export function teamTransferSpace(storageRoot: string): TeamTransferSpace {
  const globals = globalThis as unknown as Record<symbol, SpaceRegistry | undefined>;
  const registry = globals[SPACE_KEY] ?? new Map<string, TeamTransferSpace>();
  globals[SPACE_KEY] = registry;
  const key = path.resolve(storageRoot);
  let space = registry.get(key);
  if (!space) {
    space = createTeamTransferSpace({ storageRoot: key });
    registry.set(key, space);
  }
  return space;
}
