/**
 * 诊断探针：用项目 PS515 的真实输入复跑 generateScriptV3（公司模型 GPT-5-6-Luna-Standard），
 * 逐次落盘模型返回的原始 JSON，定位「两次修正后仍未返回有效脚本结构」的具体失配规则。
 * 只读数据库；产物写到 outputs/probe-luna/（gitignored）。真实调用公司网关，会产生少量调用。
 *
 * 运行：node scripts/probe-luna-script-gen.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// 静默加载 .env.local（COS 密钥等），不打印。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { completeJson } = await import('../lib/script-providers/index.ts');
const { generateScriptV3 } = await import('../lib/script-generation-v3.ts');
const { prepareScriptVisionImage } = await import('../lib/script-vision-image.ts');
const { getScriptTemplate } = await import('../lib/script-templates.ts');

const PROJECT_ID = '63eb6b16-dc18-40ae-9601-0d57da9cf8c2';
const SHOT_SET_ID = process.argv[2] || 'c9b30a45-8ff4-4cde-aa54-16c7e4660f56';
const PROVIDER_ID = 'gpt';
const TEMPLATE_ID = 'feature_showcase';
const TARGET_DURATION_SEC = 20;

const outDir = path.resolve('outputs/probe-luna');
fs.mkdirSync(outDir, { recursive: true });

const db = new Database(path.resolve('data/workbench.db'), { readonly: true, fileMustExist: true });
const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(PROJECT_ID) as Record<string, unknown>;
if (!project) throw new Error('项目不存在');

// 与 script-generation-v3-service 相同的分镜图读取口径（生成图优先，回退原图）。
const shotRows = db.prepare(`
  SELECT
    s.id AS shotId,
    s.indexNum,
    source.id AS sourceImageAssetId,
    source.filename AS sourceFilename,
    source.path AS sourceImagePath,
    source.mimeType AS sourceMimeType,
    generated.id AS generatedImageAssetId,
    generated.filename AS generatedFilename,
    generated.path AS generatedImagePath,
    generated.mimeType AS generatedMimeType
  FROM shots s
  JOIN shot_sets ss ON ss.id = s.shotSetId
  JOIN image_assets source ON source.id = s.sourceImageId
  LEFT JOIN image_assets generated ON generated.id = s.latestGeneratedImageId
  WHERE ss.projectId = ? AND ss.id = ?
  ORDER BY s.indexNum
`).all(PROJECT_ID, SHOT_SET_ID) as Array<Record<string, string | null>>;

const storageRoot = path.resolve('storage');
const maxBytesPerImage = Math.min(384 * 1024, Math.floor((4 * 1024 * 1024) / Math.max(1, shotRows.length)));
const visuals = [];
for (const row of shotRows) {
  const candidates = [
    row.generatedImagePath ? { assetId: row.generatedImageAssetId, filename: row.generatedFilename, relPath: row.generatedImagePath, mime: row.generatedMimeType } : null,
    { assetId: row.sourceImageAssetId, filename: row.sourceFilename, relPath: row.sourceImagePath, mime: row.sourceMimeType },
  ].filter(Boolean) as Array<{ assetId: string | null; filename: string | null; relPath: string; mime: string | null }>;
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate.relPath) ? candidate.relPath : path.join(storageRoot, candidate.relPath);
    if (!fs.existsSync(absolute)) continue;
    const mimeType = candidate.mime && candidate.mime.startsWith('image/') ? candidate.mime : 'image/jpeg';
    const prepared = await prepareScriptVisionImage({
      imageBuffer: fs.readFileSync(absolute),
      mimeType,
      maxBytes: maxBytesPerImage,
    });
    visuals.push({
      shotId: String(row.shotId),
      shotIndex: Number(row.indexNum),
      imageAssetId: String(candidate.assetId || ''),
      sourceFilename: String(candidate.filename || ''),
      mimeType: prepared.mimeType,
      imageBase64: prepared.imageBuffer.toString('base64'),
    });
    break;
  }
}
console.log(`分镜图 ${visuals.length}/${shotRows.length} 张已就绪`);

// 与用户最近一次成功草稿一致的卖点选择。
const draft = db.prepare('SELECT inputSnapshot FROM script_drafts WHERE id LIKE ?').get('57961325%') as { inputSnapshot: string };
const snapshot = JSON.parse(draft.inputSnapshot) as { selectedSellingPoints: unknown };

const template = getScriptTemplate(TEMPLATE_ID);
if (!template) throw new Error('模板不存在');

let callIndex = 0;
try {
  const result = await generateScriptV3({
  projectName: String(project.name || ''),
  productName: String(project.productName || ''),
  productCode: String(project.productCode || ''),
  productCategory: String(project.productCategory || ''),
  targetAudience: String(project.targetAudience || ''),
  tone: '种草',
  platform: '通用',
  selectedSellingPoints: snapshot.selectedSellingPoints as never,
  templateId: template.id,
  templateName: template.name,
  targetDurationSec: TARGET_DURATION_SEC,
  shotSetId: SHOT_SET_ID,
  visuals,
}, {
  completeJson: async (request) => {
    callIndex += 1;
    const startedAt = Date.now();
    console.log(`→ 第 ${callIndex} 次调用（温度参数 ${request.temperature}，图片 ${request.images?.length ?? 0} 张）…`);
    const parsed = await completeJson({ providerId: PROVIDER_ID, ...request });
    fs.writeFileSync(
      path.join(outDir, `attempt-${callIndex}.json`),
      JSON.stringify(parsed, null, 2),
    );
    console.log(`← 第 ${callIndex} 次返回（${((Date.now() - startedAt) / 1000).toFixed(1)}s），已存 outputs/probe-luna/attempt-${callIndex}.json`);
    return parsed;
  },
  onProgress: (progress) => {
    if (progress.phase === 'validating') console.log(`  校验第 ${progress.attempt} 次输出…`);
  },
});

  console.log(`成功：第 ${result.attempts} 次通过校验，标题「${result.script.title}」`);
} catch (error) {
  console.log(`失败：${error instanceof Error ? error.message : String(error)}`);
  console.log('各次原始返回已落盘 outputs/probe-luna/，可对照校验规则定位失配点。');
  process.exitCode = 1;
} finally {
  db.close();
}
