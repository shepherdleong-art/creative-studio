import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { assertNoStorageSymlink } from './storage-path.ts';

export interface VerifiedZipFile { filename: string; relativePath: string; sha256: string }

/** Shared strict ZIP transport: fixed names, full-content verification, no skipped files or silent rename. */
export async function verifyZipFile(storageRoot: string, file: VerifiedZipFile, signal?: AbortSignal): Promise<void> {
  const hash = createHash('sha256');
  const absolute = assertNoStorageSymlink(storageRoot, file.relativePath);
  if (!fs.statSync(absolute).isFile() || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('ZIP 文件身份无效');
  for await (const chunk of fs.createReadStream(absolute, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256) throw new Error('ZIP 文件内容已变化');
}

export function buildVerifiedZipStream(storageRoot: string, files: VerifiedZipFile[],
  documents: Array<{ filename: string; text: string }>, options: { date: Date; signal?: AbortSignal }): ReadableStream<Uint8Array> {
  options.signal?.throwIfAborted();
  const names = new Set<string>();
  for (const entry of [...files, ...documents]) {
    const normalized = entry.filename.normalize('NFC').toLowerCase();
    if (!entry.filename || entry.filename.startsWith('/') || /[\\<>:"|?*\x00-\x1f]/.test(entry.filename)
      || entry.filename.split('/').some(part => !part || part === '.' || part === '..') || names.has(normalized)) {
      throw new Error('ZIP 文件名无效或重复');
    }
    names.add(normalized);
  }
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const pass = new PassThrough();
  const sources = new Set<Readable>();
  let closed = false;
  const stop = (error?: Error) => {
    if (closed) return; closed = true;
    archive.abort();
    for (const source of sources) source.destroy(error);
    if (error) pass.destroy(error);
    options.signal?.removeEventListener('abort', abort);
  };
  const fail = (error: Error) => stop(error);
  const abort = () => fail(new Error('ZIP 下载已取消'));
  archive.on('error', fail);
  archive.on('warning', fail); // A missing file is an error, never a partial successful archive.
  pass.on('close', () => stop());
  options.signal?.addEventListener('abort', abort, { once: true });
  archive.pipe(pass);
  for (const entry of files) {
    const source = Readable.from((async function* () {
      const hash = createHash('sha256');
      const absolute = assertNoStorageSymlink(storageRoot, entry.relativePath);
      const reader = fs.createReadStream(absolute, { signal: options.signal });
      try {
        for await (const chunk of reader) { hash.update(chunk); yield chunk; }
        if (hash.digest('hex') !== entry.sha256) throw new Error('ZIP 文件在下载期间发生变化');
      } finally { reader.destroy(); }
    })());
    sources.add(source);
    source.on('error', fail);
    source.on('close', () => sources.delete(source));
    archive.append(source, { name: entry.filename, date: options.date, store: true });
  }
  for (const entry of documents) archive.append(entry.text, { name: entry.filename, date: options.date });
  void archive.finalize().catch(fail);
  return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
}
