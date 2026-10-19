import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const dialogUrl = new URL('../components/ProjectInfoDialog.tsx', import.meta.url);
assert.ok(existsSync(dialogUrl), 'shared ProjectInfoDialog component should exist');

const dialogSource = readFileSync(dialogUrl, 'utf8');

for (const label of ['项目名称', '产品名称', '产品型号', '品类']) {
  assert.match(dialogSource, new RegExp(label), `dialog should render the ${label} field`);
}

assert.ok(
  (dialogSource.match(/h-11/g) || []).length >= 4,
  'all four inputs should use the same h-11 height',
);
assert.ok(
  (dialogSource.match(/content-start/g) || []).length >= 4,
  'each field should align its content to the top of its grid cell',
);
assert.match(dialogSource, /intent === 'export'/);
assert.match(dialogSource, /保存并开始导出/);
assert.match(dialogSource, /method:\s*'PATCH'/);
assert.match(dialogSource, /项目名称不能为空/);
assert.match(dialogSource, /请填写产品型号后再导出/);

const projectPageSource = readFileSync(new URL('../app/projects/[id]/page.tsx', import.meta.url), 'utf8');
const mixcutPanelSource = readFileSync(new URL('../components/mixcut/MixcutPanel.tsx', import.meta.url), 'utf8');
const mixcutContextSource = readFileSync(new URL('../lib/final-edit/mixcut-context.ts', import.meta.url), 'utf8');
const finalEditTypesSource = readFileSync(new URL('../lib/final-edit/types.ts', import.meta.url), 'utf8');
const exportStepSource = readFileSync(new URL('../components/mixcut/ExportStep.tsx', import.meta.url), 'utf8');

assert.match(projectPageSource, /<ProjectInfoDialog/);
assert.match(projectPageSource, /项目信息/);
assert.match(mixcutPanelSource, /<ProjectInfoDialog/);
assert.match(mixcutPanelSource, /项目信息/);

assert.match(mixcutContextSource, /SELECT id, name, productName, productCode, productCategory, createdAt FROM projects/);
assert.match(mixcutContextSource, /productCategory: projectRow\.productCategory \|\| ''/);
assert.match(finalEditTypesSource, /project:\s*{[\s\S]*?productCategory: string;/);


assert.match(exportStepSource, /<ProjectInfoDialog/);
assert.match(exportStepSource, /填写信息并导出/);
assert.match(exportStepSource, /立即填写/);
assert.match(exportStepSource, /填写产品型号后自动生成/);
assert.match(exportStepSource, /编辑项目信息/);
assert.match(exportStepSource, /projectInfoIntent === 'export'/);
assert.match(exportStepSource, /videoFilename:\s*predictedBaseName\s*\?/);
assert.match(exportStepSource, /coverFilename:\s*predictedBaseName\s*\?/);

const exportDialogIndex = exportStepSource.indexOf('<ProjectInfoDialog');
const exportFragmentCloseIndex = exportStepSource.lastIndexOf('</>');
assert.ok(
  exportDialogIndex > -1 && exportDialogIndex < exportFragmentCloseIndex,
  'export dialog must be mounted inside the returned fragment',
);

const topbarRightIndex = mixcutPanelSource.indexOf(`className={styles.topbarRight}`);
const topbarEditIndex = mixcutPanelSource.indexOf('setProjectInfoOpen(true)', topbarRightIndex);
const aspectSegmentIndex = mixcutPanelSource.indexOf(`className={styles.seg}`, topbarRightIndex);
assert.ok(
  topbarRightIndex > -1 && topbarEditIndex > topbarRightIndex && topbarEditIndex < aspectSegmentIndex,
  'mixcut project info entry must sit beside, not inside, the aspect control',
);

assert.ok(mixcutPanelSource.indexOf('<ProjectInfoDialog') < mixcutPanelSource.indexOf('{pendingShotSetId &&'));
console.log('project info UI contract tests passed');
