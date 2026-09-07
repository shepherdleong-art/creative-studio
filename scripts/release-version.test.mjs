import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = '0.6.0';
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const installer = fs.readFileSync(path.join(root, 'installer', 'windows', 'CreativeStudio.iss'), 'utf8');
const portableGuide = fs.readFileSync(path.join(root, 'installer', 'windows', '使用说明-portable.txt'), 'utf8');

assert.equal(packageJson.version, expectedVersion);
assert.equal(packageLock.version, expectedVersion);
assert.equal(packageLock.packages[''].version, expectedVersion);
assert.match(installer, /#define MyAppVersion "0\.6\.0"/);
assert.match(portableGuide, /创意工作台-0\.6\.0-免安装版/);
assert.doesNotMatch(portableGuide, /创意工作台-0\.5\.2-免安装版/);
assert.match(portableGuide, /迁移旧版数据\.cmd/);
assert.match(portableGuide, /stop-windows\.cmd/);
assert.match(portableGuide, /http:\/\/127\.0\.0\.1:4000/);
assert.doesNotMatch(portableGuide, /把旧目录里的 data\\ 和 storage\\ 两个文件夹整个拷进新目录/);
assert.match(portableGuide, /主包完整复制为一份独立的 QA 副本/, '验收说明必须明确只启动 QA 副本');
assert.match(portableGuide, /只提交 1 个最小真实任务/, '未经再次授权不得做多次计费验收');
assert.doesNotMatch(portableGuide, /Luna 脚本、image2-medium 图片、七牛云图片、可灵 3\.0 首尾帧、短豆包 TTS/);

console.log('release version contract test passed');
