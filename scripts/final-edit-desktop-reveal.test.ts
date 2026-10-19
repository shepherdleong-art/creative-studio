import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePublishedVideoForReveal, revealCommand } from '../lib/final-edit/desktop-reveal.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-reveal-'));
const storageRoot = path.join(root, 'storage');
const relativePath = 'projects/project-1/成片/成片-SKU-20260724.mp4';
const absolutePath = path.join(storageRoot, relativePath);
fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
fs.writeFileSync(absolutePath, 'video');

assert.equal(resolvePublishedVideoForReveal(storageRoot, JSON.stringify({ publishedVideoRelativePath: relativePath })), absolutePath);
assert.throws(() => resolvePublishedVideoForReveal(storageRoot, JSON.stringify({ videoRelativePath: '../../secret.mp4' })), /已发布|路径/);
assert.throws(() => resolvePublishedVideoForReveal(storageRoot, JSON.stringify({ publishedVideoRelativePath: 'projects/project-1/成片/missing.mp4' })), /不存在/);
const outsideFile = path.join(root, 'outside.mp4');
fs.writeFileSync(outsideFile, 'outside');
const linkedVideo = path.join(storageRoot, 'projects/project-1/成片/linked.mp4');
fs.symlinkSync(outsideFile, linkedVideo);
assert.throws(() => resolvePublishedVideoForReveal(storageRoot, JSON.stringify({ publishedVideoRelativePath: path.relative(storageRoot, linkedVideo) })), /符号链接/);
assert.deepEqual(revealCommand('darwin', absolutePath), { command: 'open', args: ['-R', absolutePath] });
assert.deepEqual(revealCommand('win32', absolutePath), { command: 'explorer.exe', args: [`/select,${absolutePath}`] });
assert.throws(() => revealCommand('linux', absolutePath), /不支持/);

console.log('final-edit desktop reveal tests passed');
