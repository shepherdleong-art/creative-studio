import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { sha256, projectFile } from '../../film-render/files.ts';
import { FinalEditError } from '../errors.ts';
import type { FilmBinding } from './types.ts';

export function deliveryNames(baseName: string, version: number) {
  const name = `${baseName}${version === 1 ? '' : `-v${version}`}`;
  return { videoFilename: `${name}.mp4`, coverFilename: `${name}-封面.jpg` };
}
function marker(binding: FilmBinding) { return path.join(binding.deliveryDir, '.creative-studio', binding.id, 'identity.json'); }
export function verifyDeliveryDirectory(binding: FilmBinding, initialize = false) {
  if (!fs.existsSync(binding.deliveryDir) || fs.realpathSync(binding.deliveryDir) !== binding.deliveryDir || !fs.statSync(binding.deliveryDir).isDirectory()) {
    throw new FinalEditError('film_delivery_unavailable', '原交付目录不可访问，请恢复磁盘或目录权限', 409);
  }
  const file = marker(binding);
  for (const candidate of [path.dirname(path.dirname(file)), path.dirname(file), file]) {
    if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== candidate) throw new FinalEditError('film_delivery_identity', '交付身份目录不能包含符号链接', 409);
  }
  if (!fs.existsSync(file) && initialize && binding.deliveryVersion === 1) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id: binding.id, token: binding.reviewToken }), { flag: 'wx', mode: 0o600 });
  }
  if (!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).token !== binding.reviewToken) {
    throw new FinalEditError('film_delivery_identity', '交付目录身份标记缺失或不匹配，已停止写入', 409);
  }
}
function ownFile(directory: string, name: string, hash: string): string | null {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink() || sha256(projectFile(directory, name)) !== hash) {
    throw new FinalEditError('film_delivery_conflict', `交付文件被修改或已占用：${name}`, 409);
  }
  return file;
}
export function publishFilmPair(binding: FilmBinding, version: number, video: string, cover: string) {
  verifyDeliveryDirectory(binding);
  const names = deliveryNames(binding.baseName, version);
  const pair = [[names.videoFilename, video, sha256(video)], [names.coverFilename, cover, sha256(cover)]];
  // Preflight both before publishing either; retries may recover our already-copied files.
  for (const [name, , hash] of pair) ownFile(binding.deliveryDir, name, hash);
  const created: Array<[string, string]> = [];
  try {
    for (const [name, source, hash] of pair) {
      if (ownFile(binding.deliveryDir, name, hash)) continue;
      const staging = path.join(path.dirname(marker(binding)), `${version}-${name}.partial`);
      if (fs.lstatSync(staging, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('交付暂存文件不能是符号链接');
      fs.copyFileSync(source, staging);
      if (sha256(staging) !== hash) throw new Error('交付暂存文件校验失败');
      const destination = path.join(binding.deliveryDir, name);
      try { fs.copyFileSync(staging, destination, fs.constants.COPYFILE_EXCL); created.push([destination, hash]); }
      catch (error) { if (!ownFile(binding.deliveryDir, name, hash)) throw error; }
      fs.unlinkSync(staging);
    }
  } catch (error) {
    for (const [file, hash] of created) { try { if (sha256(file) === hash) fs.unlinkSync(file); } catch { /* preserve evidence on a locked/offline volume */ } }
    throw error;
  }
  return { ...names, videoSha256: pair[0][2], coverSha256: pair[1][2] };
}
export function archivePriorFilm(db: Database.Database, binding: FilmBinding, version: number): string | null {
  if (version <= 1) return null;
  verifyDeliveryDirectory(binding);
  const previous = db.prepare('SELECT videoFilename,coverFilename,videoSha256,coverSha256 FROM final_edit_film_deliveries WHERE bindingId=? AND version=? AND status=\'published\'').get(binding.id, version - 1) as { videoFilename: string; coverFilename: string; videoSha256: string; coverSha256: string } | undefined;
  if (!previous) return null;
  const archive = path.join(binding.deliveryDir, '旧版');
  try {
    fs.mkdirSync(archive, { recursive: true });
    if (fs.realpathSync(archive) !== archive) throw new Error('旧版目录不能是符号链接');
    for (const [name, hash] of [[previous.videoFilename, previous.videoSha256], [previous.coverFilename, previous.coverSha256]]) {
      const source = ownFile(binding.deliveryDir, name, hash);
      const target = ownFile(archive, name, hash);
      if (!source) { if (!target) throw new Error(`旧文件缺失：${name}`); continue; }
      if (!target) fs.copyFileSync(source, path.join(archive, name), fs.constants.COPYFILE_EXCL);
      ownFile(archive, name, hash);
      fs.unlinkSync(source);
    }
    return null;
  } catch (error) {
    return `新版已交付，旧版归档尚未完成：${error instanceof Error ? error.message : String(error)}。关闭占用后可重试归档。`;
  }
}
