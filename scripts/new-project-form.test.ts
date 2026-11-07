/**
 * 新建项目表单与员工可见文案（06 号票）。
 *
 * 三条验收：
 *   1. 新建项目页不再出现超时 / 并发 / 图片预处理四个控件（V06）；
 *   2. 缺项提示写在按钮旁，不用浏览器弹窗，且「缺什么」是一份可测试的清单（V08）；
 *   3. 员工可见状态文字里「等待并发空位」改成「排队中」。
 *
 * 页面在浏览器里，所以这里读源码断言「控件没回来」，并直接测纯校验函数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const {
  FIRST_STEP_EMPTY_HINT,
  REMOVED_NEW_PROJECT_CONTROLS,
  validateNewProjectDraft,
} = await import('../lib/new-project-form.ts');

// ── 缺项校验：清单 + 一句话提示 ──
const empty = { storeCode: '', productCode: '', productSubmodel: '', productionType: '', editorName: '' };
const provider = { id: 'p1', name: '测试', model: 'gpt-image-2', type: 'openai-compatible', hasApiKey: true };

assert.deepEqual(validateNewProjectDraft(empty, provider).missing, ['店铺', '型号', '生产类型', '剪辑师'],
  '空表单必须一次列出全部缺项，顺序与表单一致');
assert.equal(validateNewProjectDraft(empty, provider).message, '还差店铺、型号、生产类型、剪辑师，填完就能创建。',
  '提示语必须写在按钮旁能读懂的一句话');

assert.deepEqual(
  validateNewProjectDraft({ ...empty, storeCode: 'B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷' }, null).missing,
  ['供应商'],
  '生产身份填齐但没选供应商时，提示要指向供应商',
);
assert.deepEqual(
  validateNewProjectDraft({ ...empty, storeCode: 'B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷' },
    { ...provider, hasApiKey: false }).missing,
  ['供应商 API Key'],
  '供应商没配 Key 也要在按钮旁提示，而不是提交后 400',
);
assert.deepEqual(
  validateNewProjectDraft({ ...empty, storeCode: 'B店', productCode: ' XQ9A ', productionType: 'AI种草', editorName: ' 紫菜卷 ' }, provider).missing,
  [],
  '首尾空格不应被当成没填',
);

// ── 页面源码：四个控件必须真的消失 ──
const page = read('app/(workspace)/projects/new/page.tsx');
for (const label of REMOVED_NEW_PROJECT_CONTROLS) {
  // 「图片预处理」在副标题里作为「由服务器统一管理」的说明词可以出现，
  // 但作为控件标签（前面紧跟 <label>/<GroupRow label>）必须不存在。
  if (label === '图片预处理') {
    assert.doesNotMatch(page, /label="图片预处理"/, '新建项目页不得再有「图片预处理」控件');
    continue;
  }
  assert.doesNotMatch(page, new RegExp(`(label|aria-label)="${label}"|>${label}<`),
    `新建项目页不得再有「${label}」控件`);
}
for (const stateName of ['setTimeoutMs', 'setConcurrency', 'setPreprocessEnabled', 'setTargetMaxSide', 'setJpegQuality']) {
  assert.doesNotMatch(page, new RegExp(`\\b${stateName}\\b`), `新建项目页不得再维护 ${stateName} 这类生产参数状态`);
}
assert.doesNotMatch(page, /alert\(/, '校验提示写在按钮旁，不许再用浏览器弹窗');
assert.match(page, /data-testid="new-project-hint"/, '缺项提示必须有稳定落点供页面级测试断言');
assert.match(page, /data-testid="project-name-preview"/, '项目名实时预览必须有稳定落点');
assert.match(page, /data-testid="new-project-submit"/, '创建按钮必须有稳定落点');
// 项目名预览是受控 span、输入框各有稳定 aria-label：打字不会重建输入框，因此不丢焦点。
assert.match(page, /aria-label="型号"/);
assert.match(page, /aria-label="剪辑师"/);
assert.match(page, /editorName: draft\.editorName\.trim\(\)/, '提交时用当前 state，而不是快照');

// ── 保留的字段都还在 ──
for (const kept of ['店铺', '型号', '子型号', '生产类型', '剪辑师', '模型', '画面比例', '清晰度', '质量']) {
  assert.match(page, new RegExp(`aria-label="${kept === '模型' ? '模型' : kept}"|>${kept}<`),
    `新建项目页必须保留「${kept}」`);
}

// ── 第 1 步空状态：写明下一步 ──
assert.match(FIRST_STEP_EMPTY_HINT, /原始场景图/, '第 1 步空状态必须告诉用户先放一张原始场景图');
assert.match(page, /router\.push\(`\/projects\/\$\{data\.id\}`\)/, '创建后必须直接进入第 1 步');

// ── 「等待并发空位」→「排队中」 ──
const gallery = read('components/ResultGallery.tsx');
assert.doesNotMatch(gallery, /等待并发空位/, '员工可见状态文字不得再出现「等待并发空位」');
assert.match(gallery, /排队中，前面的任务完成后自动开始/, '排队状态要写成「排队中」并说明会自动开始');

// 整个员工可见代码里不应再有这句工程用语（文档/原型目录除外）。
const offenders: string[] = [];
const walk = (directory: string) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (!/\.(tsx?|mjs)$/.test(entry.name)) continue;
    if (read(path.relative(repoRoot, absolute)).includes('等待并发空位')) {
      offenders.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
    }
  }
};
for (const directory of ['app', 'components', 'lib']) walk(path.join(repoRoot, directory));
assert.deepEqual(offenders, [], `员工可见代码里还有「等待并发空位」：${offenders.join(', ')}`);

console.log('new project form tests passed');
