import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const dialogUrl = new URL('../components/ProjectInfoDialog.tsx', import.meta.url);
assert.ok(existsSync(dialogUrl), 'shared ProjectInfoDialog component should exist');

const dialogSource = readFileSync(dialogUrl, 'utf8');

for (const label of ['店铺', '生产类型', '型号', '子型号', '剪辑师']) {
  assert.match(dialogSource, new RegExp(label), `dialog should render the ${label} field`);
}

assert.ok(
  (dialogSource.match(/h-11/g) || []).length >= 5,
  'all five inputs should use the same h-11 height',
);
assert.ok(
  (dialogSource.match(/content-start/g) || []).length >= 5,
  'each field should align its content to the top of its grid cell',
);
assert.match(dialogSource, /intent === 'export'/);
assert.match(dialogSource, /保存并开始导出/);
assert.match(dialogSource, /method:\s*'PATCH'/);
assert.match(dialogSource, /请填写产品型号/);
assert.match(dialogSource, /项目名称（自动生成）/);
assert.match(dialogSource, /ENABLE_NEW_EXPORT_IDENTITY_KEY/, '弹窗必须通过共享常量发送确认字段，与 PATCH 路由共用同一契约');
assert.match(dialogSource, /project\.hasExportIdentity && identityChanged/);

const projectPageSource = readFileSync(new URL('../app/projects/[id]/page.tsx', import.meta.url), 'utf8');
const mixcutPanelSource = readFileSync(new URL('../components/mixcut/MixcutPanel.tsx', import.meta.url), 'utf8');
const mixcutContextSource = readFileSync(new URL('../lib/final-edit/mixcut-context.ts', import.meta.url), 'utf8');
const finalEditTypesSource = readFileSync(new URL('../lib/final-edit/types.ts', import.meta.url), 'utf8');
const exportStepSource = readFileSync(new URL('../components/mixcut/ExportStep.tsx', import.meta.url), 'utf8');

assert.match(projectPageSource, /<ProjectInfoDialog/);
assert.match(projectPageSource, /项目信息/);
assert.match(mixcutPanelSource, /<ProjectInfoDialog/);
assert.match(mixcutPanelSource, /项目信息/);

assert.match(mixcutContextSource, /SELECT id, name, productName, productCode, productCategory, createdAt,[\s\S]*?storeCode, productSubmodel, productionType, editorName, namingDate, currentExportIdentityId\s+FROM projects/);
assert.match(mixcutContextSource, /productCategory: projectRow\.productCategory \|\| ''/);
assert.match(mixcutContextSource, /storeCode: projectRow\.storeCode \|\| ''/);
assert.match(mixcutContextSource, /editorName: projectRow\.editorName \|\| ''/);
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

const topbarRightIndex = mixcutPanelSource.indexOf('topbarRight={(');
const topbarEditIndex = mixcutPanelSource.indexOf('setProjectInfoOpen(true)', topbarRightIndex);
const aspectSegmentIndex = mixcutPanelSource.indexOf(`className={styles.seg}`, topbarRightIndex);
assert.ok(
  topbarRightIndex > -1 && topbarEditIndex > topbarRightIndex && topbarEditIndex < aspectSegmentIndex,
  'mixcut project info entry must sit beside, not inside, the aspect control',
);

assert.ok(mixcutPanelSource.indexOf('<ProjectInfoDialog') < mixcutPanelSource.indexOf('{pendingShotSetId &&'));
console.log('project info UI contract tests passed');
