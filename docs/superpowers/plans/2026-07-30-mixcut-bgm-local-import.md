# Mixcut Local BGM Import and Audition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在智能混剪“背景音乐”卡片中加入本地多文件导入、可读文件名去重、导入后自动选择和独立试听，同时保持现有草稿 revision、时间线预览与最终渲染行为不回归。

**Architecture:** 新增独立的 BGM 文件导入领域服务与 multipart HTTP 适配层，API 路由只组装依赖、返回状态码；曲目列表统一由服务端读模型生成 `filename`。前端把 BGM 卡片抽成独立组件，上传完成后在现有串行队列内刷新 group 并提交 `set_bgm`，试听使用现有媒体接口，父组件通过 stop request 协调试听与成片播放互斥。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript strict、SQLite/`better-sqlite3`、Node.js `fs`/`crypto`/Web File API、FFmpeg/ffprobe、Playwright、CSS Modules。

---

## 实施前约束

- 当前工作区已有用户未提交修改，尤其包括 `lib/final-edit/types.ts`。每次编辑前先运行 `git diff -- <目标文件>`，只合并本功能所需行，不覆盖或格式化无关改动。
- 每次提交只暂存本任务列出的文件；禁止使用 `git add .`。
- 本功能不新增数据库迁移，不改动 `final_edit_bgm_tracks` 表结构。
- 文件必须直接落在 `dataRoot()/storage/bgm/` 根目录；文件名和目录名不得出现哈希或 UUID。
- 完全相同内容仍可使用现有 `fileFingerprint` 做内部去重，但它不得出现在响应展示字段或界面。
- API 不接受项目、分镜组、成片组或目标目录参数。上传属于全局音乐库，选择 BGM 才属于当前 variant。
- 独立试听播放原始音量；只有成片预览和最终渲染应用 gain、淡入、淡出与循环。
- 不顺手处理导出视频文件名、文件夹导入、删除/重命名音乐、搜索分类等非目标。

## 文件变更地图

### 新增

- `lib/final-edit/bgm-import.ts`：文件名校验、音频探测、流式指纹、完全重复复用、可读同名序号、并发落位、数据库索引与回滚。
- `lib/final-edit/bgm-import-http.ts`：multipart 解析、100/256 MB/512 MB 限制、逐文件暂存和清理。
- `app/api/final-edit-bgm/route.ts`：全局 BGM 导入 POST 路由与 200/201/422 状态映射。
- `components/mixcut/BgmCard.tsx`：下拉选择、添加音乐、结果播报、试听/停止、现有三个参数滑杆。
- `scripts/final-edit-bgm-import.test.ts`：领域、文件、HTTP 和媒体 Range 回归。

### 修改

- `lib/final-edit/bgm.ts`：导出支持扩展名常量，并提供带 `filename` 的统一 ready 曲目查询。
- `lib/final-edit/types.ts`：增加 `FinalEditBgmTrackView`、`BgmImportResponse`，更新 `FinalEditGroupView.bgmTracks`。
- `lib/final-edit/workspace.ts`：group read model 复用统一 BGM 列表函数。
- `components/mixcut/PreviewStep.tsx`：挂载 `BgmCard`，在串行队列中执行上传→刷新→`set_bgm`，协调两个播放器。
- `components/final-edit/FinalEditPreview.tsx`：支持外部停止请求，并在成片开始播放前通知父组件。
- `components/mixcut/MixcutPanel.module.css`：BGM 操作行、隐藏文件输入、状态文字与窄栏布局。
- `scripts/final-edit-workspace.test.ts`：验证 group 返回可读 `filename`。
- `scripts/final-edit-mixcut-ui-contract.test.mjs`：新增结构、可访问性和互斥接线契约。
- `scripts/final-edit-mixcut.playwright.test.mjs`：真实页面导入、自动选择、试听和播放互斥。
- `scripts/final-edit-render.test.ts`：使用 `storage/bgm/中文 空格(1).wav` 做真实 FFmpeg 渲染。

## Task 1: 统一 BGM 曲目读模型并输出可读文件名

**Files:**

- Modify: `lib/final-edit/types.ts`
- Modify: `lib/final-edit/bgm.ts`
- Modify: `lib/final-edit/workspace.ts`
- Test: `scripts/final-edit-workspace.test.ts`

- [ ] **Step 1: 检查重叠修改并写失败测试**

先执行：

```powershell
git diff -- lib/final-edit/types.ts lib/final-edit/bgm.ts lib/final-edit/workspace.ts scripts/final-edit-workspace.test.ts
```

在 `scripts/final-edit-workspace.test.ts` 创建一个 ready 曲目后重新加载现有 group：

```ts
db.prepare(`INSERT INTO final_edit_bgm_tracks
  (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
  VALUES (?, ?, ?, ?, ?, 'ready', ?)`).run(
  'bgm-readable-name',
  'bgm/轻快音乐(1).mp3',
  'fingerprint-readable-name',
  12_500_000,
  'mp3',
  new Date().toISOString(),
);

const groupWithBgm = workspace.load(group.id);
assert.deepEqual(groupWithBgm.bgmTracks, [{
  id: 'bgm-readable-name',
  filename: '轻快音乐(1).mp3',
  relativePath: 'bgm/轻快音乐(1).mp3',
  durationUs: 12_500_000,
}]);
```

- [ ] **Step 2: 运行测试并确认因 `filename` 缺失失败**

Run: `node scripts/final-edit-workspace.test.ts`

Expected: `deepEqual` 显示实际对象没有 `filename`。如果失败原因不是新断言，先修复测试夹具，不进入实现。

- [ ] **Step 3: 增加共享类型**

在 `lib/final-edit/types.ts` 中加入：

```ts
export interface FinalEditBgmTrackView {
  id: string;
  filename: string;
  relativePath: string;
  durationUs: number;
}

export interface BgmImportResponse {
  firstSuccessfulTrackId: string | null;
  imported: FinalEditBgmTrackView[];
  reused: FinalEditBgmTrackView[];
  errors: Array<{
    filename: string;
    code: string;
    message: string;
  }>;
  tracks: FinalEditBgmTrackView[];
}
```

把 `FinalEditGroupView` 中的字段改为：

```ts
bgmTracks: FinalEditBgmTrackView[];
```

不要移动或重排该文件中的其他用户修改。

- [ ] **Step 4: 在 `bgm.ts` 建立唯一曲目查询出口**

将扩展名集合改为导出常量，并增加：

```ts
import type { FinalEditBgmTrackView } from './types.ts';

export const FINAL_EDIT_BGM_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
]);

export function finalEditBgmFilename(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) || relativePath;
}

export function listReadyFinalEditBgmTracks(
  db: Database.Database,
): FinalEditBgmTrackView[] {
  const rows = db.prepare(`
    SELECT id, relativePath, durationUs
    FROM final_edit_bgm_tracks
    WHERE status='ready'
    ORDER BY relativePath
  `).all() as Array<{
    id: string;
    relativePath: string;
    durationUs: number;
  }>;
  return rows.map((row) => ({
    ...row,
    filename: finalEditBgmFilename(row.relativePath),
  }));
}
```

`scanFinalEditBgm` 的扫描判断也改为使用 `FINAL_EDIT_BGM_EXTENSIONS`，不要复制第二份白名单。

- [ ] **Step 5: group read model 复用统一查询**

在 `lib/final-edit/workspace.ts`：

```ts
import {
  listReadyFinalEditBgmTracks,
  scanFinalEditBgm,
} from './bgm.ts';
```

用下面一行替换内联 SQL：

```ts
const bgmTracks = listReadyFinalEditBgmTracks(db);
```

- [ ] **Step 6: 运行目标测试和类型相关检查**

Run:

```powershell
node scripts/final-edit-workspace.test.ts
npx eslint lib/final-edit/types.ts lib/final-edit/bgm.ts lib/final-edit/workspace.ts scripts/final-edit-workspace.test.ts
```

Expected: 两条命令退出码均为 0，曲目对象含可读 `filename`。

- [ ] **Step 7: 提交 Task 1**

```powershell
git add -- lib/final-edit/types.ts lib/final-edit/bgm.ts lib/final-edit/workspace.ts scripts/final-edit-workspace.test.ts
git commit -m "feat: expose readable BGM track names"
```

## Task 2: 实现可读命名、内容复用和并发安全的 BGM 导入服务

**Files:**

- Create: `lib/final-edit/bgm-import.ts`
- Create: `scripts/final-edit-bgm-import.test.ts`

- [ ] **Step 1: 先建立测试夹具和失败用例**

新测试使用临时 `storageRoot`、内存 SQLite 和可注入的探测函数：

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import {
  importFinalEditBgmFiles,
  type BgmUpload,
} from '../lib/final-edit/bgm-import.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-import-'));
const storageRoot = path.join(root, 'storage');
const uploadRoot = path.join(root, 'uploads');
fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(uploadRoot, { recursive: true });
const db = new Database(':memory:');
initFinalEditSchema(db);

let uploadIndex = 0;
function upload(filename: string, bytes: string): BgmUpload {
  const temporaryPath = path.join(uploadRoot, `upload-${uploadIndex++}`);
  fs.writeFileSync(temporaryPath, bytes);
  return {
    filename,
    mimeType: 'audio/mpeg',
    temporaryPath,
    size: fs.statSync(temporaryPath).size,
  };
}

const dependencies = {
  db,
  storageRoot,
  probeDurationSec: async (filePath: string) => {
    if (fs.readFileSync(filePath, 'utf8').startsWith('broken')) {
      throw new Error('invalid audio');
    }
    return 12.5;
  },
};
```

覆盖以下断言，保持在一个独立脚本中顺序执行：

```ts
const first = await importFinalEditBgmFiles(dependencies, [
  upload('轻快音乐.mp3', 'audio-a'),
]);
assert.equal(first.imported[0].filename, '轻快音乐.mp3');
assert.equal(first.imported[0].relativePath, 'bgm/轻快音乐.mp3');
assert.equal(first.firstSuccessfulTrackId, first.imported[0].id);
assert.equal(
  fs.readFileSync(path.join(storageRoot, 'bgm', '轻快音乐.mp3'), 'utf8'),
  'audio-a',
);

const collisions = await importFinalEditBgmFiles(dependencies, [
  upload('轻快音乐.mp3', 'audio-b'),
  upload('轻快音乐.mp3', 'audio-c'),
]);
assert.deepEqual(
  collisions.imported.map((track) => track.filename),
  ['轻快音乐(1).mp3', '轻快音乐(2).mp3'],
);

const duplicate = await importFinalEditBgmFiles(dependencies, [
  upload('另一个名字.mp3', 'audio-a'),
]);
assert.equal(duplicate.imported.length, 0);
assert.equal(duplicate.reused[0].id, first.imported[0].id);
assert.equal(duplicate.reused[0].filename, '轻快音乐.mp3');

const partial = await importFinalEditBgmFiles(dependencies, [
  upload('损坏.mp3', 'broken-audio'),
  upload('保留 原名(测试).WAV', 'audio-d'),
  upload('说明.txt', 'not-audio'),
]);
assert.equal(partial.imported[0].filename, '保留 原名(测试).WAV');
assert.deepEqual(
  partial.errors.map((error) => error.code),
  ['invalid_audio', 'unsupported_audio_format'],
);
assert.equal(partial.firstSuccessfulTrackId, partial.imported[0].id);

const concurrent = await Promise.all([
  importFinalEditBgmFiles(dependencies, [upload('并发.mp3', 'concurrent-a')]),
  importFinalEditBgmFiles(dependencies, [upload('并发.mp3', 'concurrent-b')]),
]);
assert.deepEqual(
  concurrent.flatMap((result) => result.imported).map((track) => track.filename).sort(),
  ['并发(1).mp3', '并发.mp3'],
);

const sameContent = await Promise.all([
  importFinalEditBgmFiles(dependencies, [upload('相同甲.mp3', 'same-content')]),
  importFinalEditBgmFiles(dependencies, [upload('相同乙.mp3', 'same-content')]),
]);
assert.equal(sameContent.flatMap((result) => result.imported).length, 1);
assert.equal(sameContent.flatMap((result) => result.reused).length, 1);
const sameImportedTrack = sameContent.flatMap((result) => result.imported)[0];
const sameFingerprint = db.prepare(`
  SELECT fileFingerprint
  FROM final_edit_bgm_tracks
  WHERE id = ?
`).get(sameImportedTrack.id) as { fileFingerprint: string };
assert.equal(
  (db.prepare(`
    SELECT COUNT(*) AS count
    FROM final_edit_bgm_tracks
    WHERE fileFingerprint = ?
  `).get(sameFingerprint.fileFingerprint) as { count: number }).count,
  1,
  '完全相同内容只能留下一个曲目记录',
);

const unsafe = await importFinalEditBgmFiles(dependencies, [
  upload('../../越界.mp3', 'unsafe-a'),
  upload('CON.mp3', 'unsafe-b'),
]);
assert.equal(unsafe.imported[0].filename, '越界.mp3');
assert.deepEqual(unsafe.errors.map((error) => error.code), ['invalid_filename']);
assert.equal(fs.existsSync(path.join(root, '越界.mp3')), false);
assert.equal(
  fs.readFileSync(path.join(storageRoot, 'bgm', '越界.mp3'), 'utf8'),
  'unsafe-a',
);
```

测试结尾必须关闭数据库并 `rmSync(root, { recursive: true, force: true })`。

- [ ] **Step 2: 运行并确认模块不存在**

Run: `node scripts/final-edit-bgm-import.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` 指向 `bgm-import.ts`。

- [ ] **Step 3: 定义领域输入、输出和串行锁**

在 `lib/final-edit/bgm-import.ts` 导出：

```ts
export interface BgmUpload {
  filename: string;
  mimeType: string;
  temporaryPath: string;
  size: number;
}

export interface BgmImportBatchResult {
  firstSuccessfulTrackId: string | null;
  imported: FinalEditBgmTrackView[];
  reused: FinalEditBgmTrackView[];
  errors: BgmImportResponse['errors'];
}

export interface BgmImportDependencies {
  db: Database.Database;
  storageRoot: string;
  probeDurationSec?: (filePath: string) => Promise<number>;
}

let importTail: Promise<void> = Promise.resolve();

function withBgmImportLock<T>(work: () => Promise<T>): Promise<T> {
  const scheduled = importTail.then(work, work);
  importTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}
```

`importFinalEditBgmFiles` 必须让整个批次进入同一个锁，不能只锁单个文件，否则两个并发批次仍可交叉抢名字。

- [ ] **Step 4: 实现安全文件名和可读候选名**

使用跨 Windows/macOS 的保守规则：

```ts
function safeUploadedFilename(original: string): string {
  const filename = original.split(/[\\/]/).filter(Boolean).at(-1) || '';
  const stem = path.parse(filename).name;
  if (
    !filename
    || filename === '.'
    || filename === '..'
    || filename.includes('\0')
    || /[<>:"/\\|?*\u0000-\u001f]/.test(filename)
    || /[ .]$/.test(filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
    || !stem
  ) {
    throw new FinalEditError('invalid_filename', `无法安全保存音乐文件“${original || '未命名'}”`);
  }
  return filename;
}

function numberedFilename(filename: string, index: number): string {
  if (index === 0) return filename;
  const extension = path.extname(filename);
  return `${filename.slice(0, -extension.length)}(${index})${extension}`;
}
```

扩展名用 `FINAL_EDIT_BGM_EXTENSIONS.has(path.extname(filename).toLowerCase())` 校验；扩展名大小写保持原样，数据库 `format` 写小写值。

- [ ] **Step 5: 实现流式指纹和不覆盖落位**

关键辅助函数：

```ts
async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function placeReadableFile(
  sourcePath: string,
  bgmRoot: string,
  filename: string,
): Promise<{ filename: string; absolutePath: string }> {
  const temporaryPath = path.join(bgmRoot, `.import-${crypto.randomUUID()}.tmp`);
  await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  try {
    for (let index = 0; ; index += 1) {
      const candidate = numberedFilename(filename, index);
      const absolutePath = path.join(bgmRoot, candidate);
      try {
        await fs.promises.link(temporaryPath, absolutePath);
        return { filename: candidate, absolutePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}
```

这里使用同目录、无音频扩展名的临时文件，再用 hard link 原子创建正式名字：并发时 `EEXIST` 只会推进到下一个 `(n)`，扫描器不会把半成品当成 BGM。若实际支持环境出现 `EPERM`/`ENOTSUP`，不要静默改成可覆盖写入；先补一个排他复制的受控 fallback 测试，并确保失败残留会被清理。

- [ ] **Step 6: 完成单文件导入事务语义**

每个文件严格按以下顺序：

1. 获取安全 basename；
2. 校验扩展名；
3. 对暂存文件调用注入的 `probeDurationSec`，结果必须有限且大于 0；
4. 流式计算 SHA-256；
5. 按 fingerprint 查询已有记录；其 ready 文件仍存在时直接返回 `reused`；
6. 创建并复核 `storage/bgm`，使用 `assertNoStorageSymlink` 确保目录未通过符号链接越界；
7. 使用 `placeReadableFile` 落位；
8. `relativePath` 必须用 `path.posix.join('bgm', placed.filename)`，保证 API 始终输出 `bgm/...`；
9. 在事务中插入或修复同 fingerprint 记录；
10. 数据库写入失败时删除本次正式文件并抛出 `bgm_index_failed`；
11. 磁盘失败映射为 `bgm_write_failed`，损坏音频映射为逐文件 `invalid_audio`。

数据库写入使用内部随机 ID 是允许的，但 ID 只能存在数据库/API 标识字段，不得参与磁盘名字：

```ts
const id = existing?.id || crypto.randomUUID();
db.prepare(`INSERT INTO final_edit_bgm_tracks
  (id, relativePath, fileFingerprint, durationUs, format, status, errorMessage, scannedAt)
  VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?)
  ON CONFLICT(fileFingerprint) DO UPDATE SET
    relativePath=excluded.relativePath,
    durationUs=excluded.durationUs,
    format=excluded.format,
    status='ready',
    errorMessage=NULL,
    scannedAt=excluded.scannedAt`).run(
  id,
  relativePath,
  fingerprint,
  durationUs,
  format,
  new Date().toISOString(),
);
```

插入后重新按 fingerprint 读取权威行。若未来多进程竞态导致数据库中的 `relativePath` 不是本次路径，删除本次多余文件并把权威记录作为 `reused` 返回。

- [ ] **Step 7: 保持部分成功和原始选择顺序**

`importFinalEditBgmFiles` 依次处理输入数组：

- `invalid_filename`、`unsupported_audio_format`、`invalid_audio` 放入 `errors` 后继续；
- `bgm_write_failed`、`bgm_index_failed` 作为系统级 `FinalEditError` 抛出；
- 每个成功结果按输入顺序加入 `imported` 或 `reused`；
- `firstSuccessfulTrackId` 在遇到第一条成功结果时设置一次；
- 成功返回的 track 一律使用 `listReadyFinalEditBgmTracks` 同样的 `filename` 规则。

- [ ] **Step 8: 增加故障清理和缺失复用文件测试**

追加测试：

- ready fingerprint 对应文件被手工删除后，再导入相同内容会修复文件和原记录，而不是返回不可用的 `reused`；
- 注入会抛错的数据库代理或在索引写入前触发测试钩子，断言刚落位文件被删除；
- 创建 `storage/bgm` 指向外部目录的 symlink 时返回 `bgm_write_failed`/`unsafe_path`，外部目录没有收到字节；
- 导入完成或失败后 `storage/bgm` 下没有 `.import-*.tmp`；
- 中文、空格、括号、长文件名及大写扩展名保持可读；
- 输入顺序为“复用、失败、新建”时，`firstSuccessfulTrackId` 是第一项复用的 ID。

- [ ] **Step 9: 运行领域测试和 lint**

Run:

```powershell
node scripts/final-edit-bgm-import.test.ts
npx eslint lib/final-edit/bgm-import.ts scripts/final-edit-bgm-import.test.ts
```

Expected: 全部通过，临时测试目录被清理。

- [ ] **Step 10: 提交 Task 2**

```powershell
git add -- lib/final-edit/bgm-import.ts scripts/final-edit-bgm-import.test.ts
git commit -m "feat: import BGM files with readable names"
```

## Task 3: 增加 multipart 适配层和全局导入 API

**Files:**

- Create: `lib/final-edit/bgm-import-http.ts`
- Create: `app/api/final-edit-bgm/route.ts`
- Modify: `scripts/final-edit-bgm-import.test.ts`

本任务交付的公开端点固定为 `POST /api/final-edit-bgm`，请求体只读取 multipart 字段 `files`。

- [ ] **Step 1: 先写 multipart、限制和状态契约测试**

在 `scripts/final-edit-bgm-import.test.ts` 追加真实 Web `FormData` 请求：

```ts
const form = new FormData();
form.set('projectId', 'must-be-ignored');
form.set('groupId', 'must-be-ignored');
form.set('targetPath', '../../must-be-ignored');
form.append('files', new File(['first'], '第一首.mp3', { type: 'audio/mpeg' }));
form.append('files', new File(['second'], '第二首.wav', { type: 'audio/wav' }));

const stagedNames: string[] = [];
const parsed = await importFinalEditBgmFromFormData(
  new Request('http://local/api/final-edit-bgm', { method: 'POST', body: form }),
  async (uploads) => {
    assert.equal(uploads.length, 1, 'HTTP 层必须逐文件暂存，控制第二份磁盘占用');
    assert.ok(fs.existsSync(uploads[0].temporaryPath));
    stagedNames.push(uploads[0].filename);
    return {
      firstSuccessfulTrackId: `track-${stagedNames.length}`,
      imported: [{
        id: `track-${stagedNames.length}`,
        filename: uploads[0].filename,
        relativePath: `bgm/${uploads[0].filename}`,
        durationUs: 1_000_000,
      }],
      reused: [],
      errors: [],
    };
  },
);
assert.deepEqual(stagedNames, ['第一首.mp3', '第二首.wav']);
assert.equal(parsed.firstSuccessfulTrackId, 'track-1');
assert.deepEqual(parsed.imported.map((track) => track.id), ['track-1', 'track-2']);

assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: 'new', imported: parsed.imported, reused: [], errors: [],
}), 201);
assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: 'reused', imported: [], reused: parsed.imported, errors: [],
}), 200);
assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: null, imported: [], reused: [], errors: [{
    filename: '损坏.mp3', code: 'invalid_audio', message: '无法识别音频内容',
  }],
}), 422);
```

还要增加：

- 空 FormData → `files_required`/400；
- JSON request → `invalid_form_data`/400；
- 101 个小 File → `too_many_files`/400；
- 用导出的纯校验函数传入声明 size，验证 256 MB 单文件和 512 MB 总量边界，避免测试实际分配数百 MB；
- importer 抛系统错误后，已暂存文件和临时目录均不存在；
- 每个暂存文件路径都在 `os.tmpdir()` 的私有目录内；
- 客户端所有 scope/path 字段不会进入 importer 参数。

- [ ] **Step 2: 运行并确认 HTTP 模块不存在**

Run: `node scripts/final-edit-bgm-import.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` 指向 `bgm-import-http.ts`。

- [ ] **Step 3: 实现请求级限制**

在 `lib/final-edit/bgm-import-http.ts` 定义并导出可测试常量：

```ts
export const MAX_BGM_FILES = 100;
export const MAX_BGM_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_BGM_REQUEST_BYTES = 512 * 1024 * 1024;
```

同时导出状态映射纯函数，路由和测试必须共用，不能只用源代码正则猜状态：

```ts
export function bgmImportResponseStatus(
  result: BgmImportBatchResult,
): 200 | 201 | 422 {
  if (result.imported.length > 0) return 201;
  if (result.reused.length > 0) return 200;
  return 422;
}
```


`validateBgmUploadMetadata` 接受 `Array<{ name: string; size: number }>`，依次抛出：

- `files_required`；
- `too_many_files`；
- `file_too_large`，HTTP 413；
- `upload_too_large`，HTTP 413。

解析只取 `formData.getAll('files')`；不要兼容项目/目录字段，也不要把它们传给领域服务。

- [ ] **Step 4: 实现逐文件暂存与结果合并**

公开入口签名：

```ts
export async function importFinalEditBgmFromFormData(
  request: Request,
  importFiles: (files: BgmUpload[]) => Promise<BgmImportBatchResult>,
): Promise<BgmImportBatchResult>
```

实现复用 `material-import-http.ts` 的安全模式：

- `request.formData()` 失败转为 `invalid_form_data`；
- `fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-upload-'))`；
- 每个 File 通过 `Readable.from(file.stream())`、`Transform` 字节计数器和 `pipeline` 写入无扩展名的 `upload-<index>`；
- 写入使用 `flags: 'wx'`；
- 每个文件调用一次 `importFiles([upload])`，再立即删除暂存文件；
- 合并 `imported`、`reused`、`errors`；
- 只保留所有子结果中遇到的第一个非空 `firstSuccessfulTrackId`；
- `finally` 递归清理本次私有临时目录。

- [ ] **Step 5: 写薄 API 路由**

`app/api/final-edit-bgm/route.ts` 应保持如下结构：

```ts
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { listReadyFinalEditBgmTracks } from '@/lib/final-edit/bgm';
import { importFinalEditBgmFiles } from '@/lib/final-edit/bgm-import';
import {
  bgmImportResponseStatus,
  importFinalEditBgmFromFormData,
} from '@/lib/final-edit/bgm-import-http';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const db = getDb();
    const storageRoot = path.join(dataRoot(), 'storage');
    const result = await importFinalEditBgmFromFormData(
      request,
      (files) => importFinalEditBgmFiles({ db, storageRoot }, files),
    );
    const body = {
      ...result,
      tracks: listReadyFinalEditBgmTracks(db),
    };
    const status = bgmImportResponseStatus(result);
    return NextResponse.json(body, { status });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
```

不要在路由里调用 `scanFinalEditBgm`：导入服务已经精确索引本批文件，递归扫描会放大请求耗时并可能处理无关手工文件。

- [ ] **Step 6: 添加路由源代码契约**

测试读取 `app/api/final-edit-bgm/route.ts`，断言：

```ts
const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'app/api/final-edit-bgm/route.ts'),
  'utf8',
);
assert.match(routeSource, /importFinalEditBgmFromFormData/);
assert.match(routeSource, /bgmImportResponseStatus/);
assert.match(routeSource, /path\.join\(dataRoot\(\), 'storage'\)/);
assert.doesNotMatch(routeSource, /projectId|shotSetId|groupId|targetPath/);
```

- [ ] **Step 7: 运行 API 层测试**

Run:

```powershell
node scripts/final-edit-bgm-import.test.ts
npx eslint lib/final-edit/bgm-import-http.ts app/api/final-edit-bgm/route.ts scripts/final-edit-bgm-import.test.ts
```

Expected: multipart 顺序、清理、限制和路由状态映射全部通过。

- [ ] **Step 8: 提交 Task 3**

```powershell
git add -- lib/final-edit/bgm-import-http.ts app/api/final-edit-bgm/route.ts scripts/final-edit-bgm-import.test.ts
git commit -m "feat: add global BGM import API"
```

## Task 4: 抽出背景音乐卡片并加入导入与独立试听

**Files:**

- Create: `components/mixcut/BgmCard.tsx`
- Modify: `components/mixcut/MixcutPanel.module.css`
- Modify: `scripts/final-edit-mixcut-ui-contract.test.mjs`

- [ ] **Step 1: 写 UI 契约失败测试**

在 `scripts/final-edit-mixcut-ui-contract.test.mjs` 读取新文件：

```js
const bgmCard = fs.readFileSync('components/mixcut/BgmCard.tsx', 'utf8');

assert.match(bgmCard, /type="file"/);
assert.match(bgmCard, /multiple/);
assert.match(bgmCard, /\.mp3,.wav,.m4a,.aac,.flac,.ogg/i);
assert.match(bgmCard, />添加音乐</);
assert.match(bgmCard, /导入中…/);
assert.match(bgmCard, /aria-live="polite"/);
assert.match(bgmCard, /track\.filename/);
assert.doesNotMatch(bgmCard, />\{track\.relativePath\}</);
assert.match(bgmCard, /\/api\/final-edit-bgm\/$\{encodeURIComponent\(selectedTrackId\)\}\/file/);
assert.match(bgmCard, />试听</);
assert.match(bgmCard, />停止</);
assert.match(bgmCard, /audio\.volume = 1/);
assert.match(bgmCard, /audio\.currentTime = 0/);
assert.match(bgmCard, /stopRequestId/);
assert.match(bgmCard, /active/);
```

同时断言 CSS 含 `.bgmActions`、`.bgmImportStatus` 和真正隐藏但仍可由 label/input 触发的文件输入类。

- [ ] **Step 2: 运行并确认新组件不存在**

Run: `node scripts/final-edit-mixcut-ui-contract.test.mjs`

Expected: 读取 `BgmCard.tsx` 时 `ENOENT`。

- [ ] **Step 3: 定义组件边界**

`components/mixcut/BgmCard.tsx` 使用：

```tsx
export interface BgmImportUiResult {
  summary: string;
  details: string;
}

export function BgmCard({
  scopeId,
  tracks,
  bgm,
  revision,
  disabled,
  active,
  stopRequestId,
  onAuditionStart,
  onCommand,
  onImportFiles,
}: {
  scopeId: string;
  tracks: FinalEditBgmTrackView[];
  bgm: FinalEditVariantView['bgm'];
  revision: number;
  disabled: boolean;
  active: boolean;
  stopRequestId: number;
  onAuditionStart: () => void;
  onCommand: (command: VariantCommandInput) => Promise<boolean>;
  onImportFiles: (files: File[]) => Promise<BgmImportUiResult>;
}) {
```

`scopeId` 使用 group ID；它变化时试听必须停止。组件不直接知道 project/group API，也不自己修改 revision。

- [ ] **Step 4: 实现添加音乐交互**

要求：

- 隐藏 input：`type="file"`、`multiple`、`accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*"`；
- “添加音乐”按钮触发 `inputRef.current?.click()`；
- `onChange` 立即复制 `Array.from(event.currentTarget.files || [])`，随后把 `event.currentTarget.value = ''`，允许再次选择同一个文件；
- 导入期间 `importing=true`，按钮显示“导入中…”并禁用重复触发；
- 调用 `onImportFiles(files)` 后把 `summary` 写入卡片内 `aria-live="polite"`；
- 失败时显示“导入失败：<错误>”，且 mounted guard 防止切组/卸载后 setState；
- 下拉 option 显示 `track.filename`，title 可以保留 `relativePath` 供诊断；
- 原有“无 BGM”、音量、淡入、淡出语义和 command 不变。

- [ ] **Step 5: 实现原始音量试听**

组件内部只渲染一个无 controls 的 `audio`：

```tsx
<audio
  ref={audioRef}
  src={selectedTrackId
    ? `/api/final-edit-bgm/${encodeURIComponent(selectedTrackId)}/file`
    : undefined}
  preload="metadata"
  onEnded={() => setAuditioning(false)}
/>
```

停止函数必须可重复调用：

```ts
const stopAudition = useCallback(() => {
  const audio = audioRef.current;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  setAuditioning(false);
}, []);
```

开始试听时：

```ts
const startAudition = async () => {
  const audio = audioRef.current;
  if (!audio || !selectedTrackId) return;
  onAuditionStart();
  audio.pause();
  audio.currentTime = 0;
  audio.volume = 1;
  await audio.play();
  setAuditioning(true);
};
```

增加 effects：

- `selectedTrackId` 变化：停止上一首，不自动播放；
- `scopeId` 变化：停止；
- `active === false`：停止；
- `stopRequestId` 变化：停止；
- unmount：暂停、归零并清除状态。

“试听”在没有曲目、导入中或整体 disabled 时禁用；试听中按钮文字和 accessible name 为“停止”。

- [ ] **Step 6: 完成卡片样式**

在 `MixcutPanel.module.css` 中：

- 下拉保持整行宽度和现有圆角；
- `.bgmActions` 使用两列或 flex，窄栏下仍不拆字；
- “添加音乐”为主操作，“试听”为次操作；
- `.bgmImportStatus` 小号、可换行、不会撑宽右栏；
- 隐藏文件输入使用 `position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);`，不要用会破坏可访问性的 `display: none`；
- 不修改其他卡片全局间距。

- [ ] **Step 7: 运行契约测试和 lint**

Run:

```powershell
node scripts/final-edit-mixcut-ui-contract.test.mjs
npx eslint components/mixcut/BgmCard.tsx
```

Expected: 组件结构、可读名称、live region 和试听生命周期契约通过。

- [ ] **Step 8: 提交 Task 4**

```powershell
git add -- components/mixcut/BgmCard.tsx components/mixcut/MixcutPanel.module.css scripts/final-edit-mixcut-ui-contract.test.mjs
git commit -m "feat: add BGM import and audition card"
```

## Task 5: 在 PreviewStep 串行接入导入、自动选择和播放互斥

**Files:**

- Modify: `components/mixcut/PreviewStep.tsx`
- Modify: `components/final-edit/FinalEditPreview.tsx`
- Modify: `scripts/final-edit-mixcut-ui-contract.test.mjs`

- [ ] **Step 1: 写接线契约失败测试**

追加断言：

```js
assert.match(previewStep, /<BgmCard/);
assert.match(previewStep, /new FormData\(\)/);
assert.match(previewStep, /formData\.append\('files'/);
assert.match(previewStep, /fetch\('\/api\/final-edit-bgm'/);
assert.match(previewStep, /response\.status !== 422/);
assert.match(previewStep, /firstSuccessfulTrackId/);
assert.match(previewStep, /await reloadGroup\(targetGroupId\)/);
assert.match(previewStep, /type:\s*'set_bgm'/);
assert.match(previewStep, /previewStopRequestId/);
assert.match(previewStep, /auditionStopRequestId/);
assert.match(finalPreview, /stopRequestId/);
assert.match(finalPreview, /onPlaybackStart/);
```

- [ ] **Step 2: 运行并确认接线缺失**

Run: `node scripts/final-edit-mixcut-ui-contract.test.mjs`

Expected: `PreviewStep` 尚未挂载 `BgmCard`，测试失败。

- [ ] **Step 3: 给成片预览增加外部停止协议**

`FinalEditPreview` props 增加：

```ts
stopRequestId?: string | number;
onPlaybackStart?: () => void;
```

增加独立 ref，避免初始 render 被当作停止请求：

```ts
const lastStopRequestIdRef = useRef<string | number | undefined>(stopRequestId);

useEffect(() => {
  if (
    stopRequestId === undefined
    || stopRequestId === lastStopRequestIdRef.current
  ) return;
  lastStopRequestIdRef.current = stopRequestId;
  stopPlayback();
}, [stopPlayback, stopRequestId]);
```

在 `togglePlayback` 已成功创建/恢复 AudioContext、即将设置 `playing` 之前调用 `onPlaybackStart?.()`。停止、seek 或渲染不会触发该回调。

- [ ] **Step 4: 在 PreviewStep 建立两个 stop request**

```ts
const [previewStopRequestId, setPreviewStopRequestId] = useState(0);
const [auditionStopRequestId, setAuditionStopRequestId] = useState(0);
```

传给成片预览：

```tsx
<FinalEditPreview
  group={group}
  variant={variant}
  assets={group.assets}
  selectedAsset={null}
  playheadSec={effectivePlayheadSec}
  seekRequestId={seekRequestId}
  stopRequestId={previewStopRequestId}
  active={active}
  textTarget={null}
  onPlaybackStart={() => setAuditionStopRequestId((value) => value + 1)}
  onPlayheadChange={setPlayheadSec}
  onTextPositionChange={() => undefined}
/>
```

- [ ] **Step 5: 实现一个队列内的上传→刷新→选择**

新增 `importBgmFiles(files: File[])`。调用时先捕获 `targetGroupId = groupRef.current.id` 和当前 variant ID，然后让整个流程进入现有 `enqueue`。

HTTP 解析要把 422 当作合法“全部逐文件失败”响应：

```ts
const response = await fetch('/api/final-edit-bgm', {
  method: 'POST',
  body: formData,
});
const body = await response.json().catch(() => ({})) as Partial<BgmImportResponse> & {
  error?: string;
  message?: string;
};
if (!response.ok && response.status !== 422) {
  throw new Error(body.message || body.error || `HTTP ${response.status}`);
}
```

随后：

1. 生成摘要：“已导入 N 首”“已复用 N 首”“N 首失败”；三类只拼存在的部分；
2. 详细消息按 `文件名：原因` 拼接并交给现有 `setMessage`；
3. 如果 group 已切换，只返回摘要，不修改新 group；
4. `await reloadGroup(targetGroupId)` 获得最新 `bgmTracks`；
5. 如果没有 `firstSuccessfulTrackId`，保持原选择；
6. 从刷新后的 group 重新取目标 variant 和最新 revision；
7. 直接在当前 `enqueue` work 中 PATCH `/api/final-edit-variants/<id>`，提交 `{ expectedRevision, type: 'set_bgm', trackId }`；
8. 把返回 variant 合并进刚刷新的 group 后 `publishGroup`；
9. 不要在这个 work 内调用会再次 `enqueue` 的 `applyVariant`，否则形成队列自等待。

建议把现有 PATCH 逻辑抽成不入队的 `applyVariantNow`，由普通 `applyVariant` 和导入流程共同复用；`applyVariant` 仍保持原有公开行为：

```ts
const applyVariant = (request: VariantCommandRequest): Promise<boolean> =>
  enqueue(() => applyVariantNow(request));
```

导入接口返回第一首为复用曲目时也必须提交 `set_bgm`。

- [ ] **Step 6: 用 BgmCard 替换原内联卡片**

```tsx
<BgmCard
  scopeId={group.id}
  tracks={group.bgmTracks}
  bgm={variant.bgm}
  revision={variant.revision}
  disabled={busy}
  active={active}
  stopRequestId={auditionStopRequestId}
  onAuditionStart={() => setPreviewStopRequestId((value) => value + 1)}
  onCommand={applyVariant}
  onImportFiles={importBgmFiles}
/>
```

删除 `PreviewStep` 中旧的 BGM `section`，不得保留两套控件。`BgmCard` 仍位于原背景音乐卡片位置。

- [ ] **Step 7: 补充失败和切组行为测试契约**

静态契约至少验证：

- target group ID 在请求开始时捕获；
- 上传结束后存在 `groupRef.current.id !== targetGroupId` 防护；
- 全部失败不会调用 `set_bgm`；
- formData 请求没有手工写 `Content-Type`；
- 详细错误进入现有消息区域；
- `FinalEditPreview` 只有实际开始播放才调用 `onPlaybackStart`。

- [ ] **Step 8: 运行 UI 契约与 lint**

Run:

```powershell
node scripts/final-edit-mixcut-ui-contract.test.mjs
npx eslint components/mixcut/PreviewStep.tsx components/final-edit/FinalEditPreview.tsx components/mixcut/BgmCard.tsx
```

Expected: 所有接线契约通过，现有串行 command 断言不回归。

- [ ] **Step 9: 提交 Task 5**

```powershell
git add -- components/mixcut/PreviewStep.tsx components/final-edit/FinalEditPreview.tsx scripts/final-edit-mixcut-ui-contract.test.mjs
git commit -m "feat: connect BGM import to Mixcut preview"
```

## Task 6: 增加真实页面导入、自动选择和试听互斥测试

**Files:**

- Modify: `scripts/final-edit-mixcut.playwright.test.mjs`

- [ ] **Step 1: 更新 fixture 并写失败场景**

现有曲目补 `filename`：

```js
bgmTracks: [{
  id: 'bgm-e2e',
  filename: 'e2e.mp3',
  relativePath: 'bgm/e2e.mp3',
  durationUs: 20_000_000,
}],
```

在打开页面前 stub 媒体播放，避免 headless 浏览器因假音频字节拒绝：

```js
await page.addInitScript(() => {
  HTMLMediaElement.prototype.play = function play() {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {
    this.dispatchEvent(new Event('pause'));
  };
});
```

- [ ] **Step 2: 扩展 mock API**

在通配 `pathname.startsWith('/api/final-edit-bgm/')` 之前处理精确 POST：

```js
if (pathname === '/api/final-edit-bgm' && request.method() === 'POST') {
  const body = request.postDataBuffer();
  assert.ok(body && body.includes(Buffer.from('轻快音乐.mp3')));
  const track = {
    id: 'bgm-imported',
    filename: '轻快音乐.mp3',
    relativePath: 'bgm/轻快音乐.mp3',
    durationUs: 30_000_000,
  };
  savedGroup = {
    ...savedGroup,
    bgmTracks: [...savedGroup.bgmTracks, track],
  };
  return json({
    firstSuccessfulTrackId: track.id,
    imported: [track],
    reused: [],
    errors: [{
      filename: '损坏.mp3',
      code: 'invalid_audio',
      message: '无法识别音频内容',
    }],
    tracks: savedGroup.bgmTracks,
  }, 201);
}
```

在 variant PATCH mock 中增加：

```js
if (body.type === 'set_bgm') {
  const nextVariant = {
    ...currentVariant,
    revision: currentVariant.revision + 1,
    bgm: { ...currentVariant.bgm, trackId: body.trackId },
  };
  savedGroup = { ...savedGroup, variants: [nextVariant] };
  return json({ view: nextVariant });
}
```

- [ ] **Step 3: 写导入和自动选择断言**

进入第 3 步后：

```js
const importResponse = page.waitForResponse(
  (response) => response.url().endsWith('/api/final-edit-bgm')
    && response.request().method() === 'POST',
);
const bgmCard = page.getByRole('heading', { name: '背景音乐' }).locator('xpath=..');
await bgmCard.locator('input[type="file"][multiple]').setInputFiles([
  {
    name: '轻快音乐.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('valid-audio'),
  },
  {
    name: '损坏.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('broken-audio'),
  },
]);
await importResponse;

await page.getByText('已导入 1 首，1 首失败', { exact: true }).waitFor();
await page.getByText(/损坏\.mp3：无法识别音频内容/).waitFor();
assert.equal(
  await page.getByLabel('BGM 曲目').inputValue(),
  'bgm-imported',
);
assert.equal(variantPatchBodies.at(-1)?.type, 'set_bgm');
assert.equal(variantPatchBodies.at(-1)?.trackId, 'bgm-imported');
assert.equal(
  await page.getByLabel('BGM 曲目').locator('option:checked').textContent(),
  '轻快音乐.mp3',
);
```

测试同时断言 request header 的 `content-type` 含 multipart boundary，而不是前端手写 JSON。

- [ ] **Step 4: 写试听和互斥断言**

```js
const auditionButton = bgmCard.getByRole('button', { name: '试听', exact: true });
await auditionButton.click();
await bgmCard.getByRole('button', { name: '停止', exact: true }).waitFor();

await page.getByRole('button', { name: '播放成片', exact: true }).click();
await bgmCard.getByRole('button', { name: '试听', exact: true }).waitFor();

await bgmCard.getByRole('button', { name: '试听', exact: true }).click();
await bgmCard.getByRole('button', { name: '停止', exact: true }).waitFor();
await expectEventually(
  async () => await page.getByRole('button', { name: '播放成片', exact: true }).count() === 1,
  '启动独立试听必须停止成片播放',
);

await page.getByLabel('BGM 曲目').selectOption('bgm-e2e');
await bgmCard.getByRole('button', { name: '试听', exact: true }).waitFor();
```

再切换到导出步骤或触发现有离开预览操作，断言试听回到停止状态；若离开后组件卸载，则用 `page.evaluate` 记录 stub `pause` 调用次数并断言增加。

- [ ] **Step 5: 运行浏览器测试并修正测试本身的竞态**

Run: `node scripts/final-edit-mixcut.playwright.test.mjs`

Expected: 完整 Mixcut 浏览器测试通过。若本机已有 dev server，测试按现有逻辑复用；不要另起第二个 Next dev 导致 `.next/dev/lock` 冲突。

- [ ] **Step 6: 提交 Task 6**

```powershell
git add -- scripts/final-edit-mixcut.playwright.test.mjs
git commit -m "test: cover BGM import and audition flow"
```

## Task 7: 真实音频、中文路径与全量回归

**Files:**

- Modify: `scripts/final-edit-render.test.ts`
- Modify: `scripts/final-edit-bgm-import.test.ts`

- [ ] **Step 1: 把真实渲染夹具放进准确的音乐库路径**

修改 `scripts/final-edit-render.test.ts`：

```ts
fs.mkdirSync(path.join(storage, 'bgm'), { recursive: true });
const bgm = path.join(storage, 'bgm', '轻快 音乐(1).wav');
```

快照改为：

```ts
bgm: {
  id: 'bgm-1',
  relativePath: 'bgm/轻快 音乐(1).wav',
  fileFingerprint: bgmFingerprint,
  gainDb: -16,
  loop: true,
  fadeInSec: 0.2,
  fadeOutSec: 0.8,
},
```

保留现有时长、快慢口播、音频 RMS 等断言，不能只验证文件存在。

- [ ] **Step 2: 用真实 FFmpeg 探测覆盖扩展名伪装**

在 `scripts/final-edit-bgm-import.test.ts` 额外建立一个很短的真实 WAV：

```ts
await runFfmpeg([
  '-f', 'lavfi',
  '-i', 'sine=frequency=440:duration=0.2',
  '-ar', '48000',
  '-ac', '1',
  '-c:a', 'pcm_s16le',
  '-y', realWavPath,
]);
```

使用默认 `probeDurationSec` 导入，断言成功；把普通文本命名为 `伪装.mp3`，断言 `invalid_audio`。这一步确保领域测试中的 fake probe 没有掩盖生产验证。

- [ ] **Step 3: 验证现有媒体接口的 Range 行为**

在同一测试进程第一次加载 `data-root.ts` 之前设置 `CREATIVE_STUDIO_DATA_ROOT=root`，然后动态 import `mediaResponse`。对已导入文件请求：

```ts
const rangeResponse = mediaResponse(
  new Request('http://local/bgm', {
    headers: { Range: 'bytes=0-3' },
  }),
  realTrack.relativePath,
  'audio/wav',
);
assert.equal(rangeResponse.status, 206);
assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
assert.match(rangeResponse.headers.get('content-range') || '', /^bytes 0-3\//);
assert.equal((await rangeResponse.arrayBuffer()).byteLength, 4);
```

若测试文件的静态依赖已经间接加载 `data-root.ts`，拆成独立 `scripts/final-edit-bgm-media.test.mjs`，并用子进程环境变量启动；不要让测试读取仓库真实 `storage/`。

- [ ] **Step 4: 先运行两个真实媒体测试**

Run:

```powershell
node scripts/final-edit-bgm-import.test.ts
node scripts/final-edit-render.test.ts
```

Expected: 真实探测、Range、中文/空格/括号路径和最终混音全部通过。

- [ ] **Step 5: 运行本功能完整门禁**

Run:

```powershell
node scripts/final-edit-workspace.test.ts
node scripts/final-edit-bgm-import.test.ts
node scripts/final-edit-mixcut-ui-contract.test.mjs
node scripts/final-edit-mixcut.playwright.test.mjs
node scripts/final-edit-render.test.ts
npm run lint
npm run build
```

Expected:

- 所有 Node/Playwright 脚本退出码 0；
- ESLint 无 error；
- Next production build 与 standalone 资源同步成功；
- build 期间没有把 `storage/` 打进产物的断言失败。

- [ ] **Step 6: 手工验收**

在 `npm run dev:win` 或 `npm run dev` 中验证：

1. “背景音乐”下拉只显示文件名；
2. 一次选择多首，界面立即显示成功/失败摘要；
3. 磁盘实际得到 `storage/bgm/轻快音乐.mp3`；
4. 再导入同名不同内容得到 `轻快音乐(1).mp3`；
5. 再导入完全相同内容不新增文件；
6. 导入后自动选择本批第一首成功或复用曲目；
7. 试听从头、原始音量播放，停止后归零；
8. 成片播放和独立试听不会叠加；
9. 切曲、切成片组、离开步骤都会停止试听；
10. 导出成片继续应用当前 gain、淡入、淡出和循环。

- [ ] **Step 7: 检查范围和工作区**

Run:

```powershell
git status --short
git diff --stat HEAD~7..HEAD
git diff HEAD~7..HEAD -- app/api/final-edit-bgm lib/final-edit/bgm.ts lib/final-edit/bgm-import.ts lib/final-edit/bgm-import-http.ts components/mixcut/BgmCard.tsx components/mixcut/PreviewStep.tsx components/final-edit/FinalEditPreview.tsx
```

确认：

- 没有数据库 migration；
- 没有文件夹选择、删除、搜索或导出命名改动；
- 没有哈希/UUID 进入磁盘名字；
- 没有项目/分镜/group 参数进入导入路由；
- 没有覆盖实施前已有的用户修改。

- [ ] **Step 8: 提交最终回归**

```powershell
git add -- scripts/final-edit-render.test.ts scripts/final-edit-bgm-import.test.ts
git commit -m "test: verify BGM import render compatibility"
```

## 完成定义

只有同时满足以下条件才能宣布完成：

- 设计文档的 10 条验收标准全部有自动化测试或明确手工验收证据；
- API 的 200/201/422/400/413/500 语义与文档一致；
- 同名不同内容只用 `(n)`，完全相同内容只保留一份；
- UI 从服务端 `filename` 展示名称，不自行拆路径；
- 上传、group 刷新和 `set_bgm` 不产生 revision 竞态；
- 独立试听与成片播放互斥，生命周期清理完整；
- 真实 FFmpeg 能读取 `storage/bgm/轻快 音乐(1).wav`；
- `npm run lint`、`npm run build` 和全部列出的目标测试通过；
- 最终 `git status --short` 中只剩实施前就存在的用户工作区修改。
