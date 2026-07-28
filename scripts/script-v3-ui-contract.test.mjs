import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync(new URL('../components/ScriptPanel.tsx', import.meta.url), 'utf8');
const strategy = fs.readFileSync(new URL('../components/ScriptStrategyConfig.tsx', import.meta.url), 'utf8');
const result = fs.readFileSync(new URL('../components/ScriptResultView.tsx', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL('../components/ScriptTemplatePicker.tsx', import.meta.url), 'utf8');
const creativePackage = fs.readFileSync(new URL('../app/api/projects/[id]/creative-package/route.ts', import.meta.url), 'utf8');

assert.match(panel, /analyzed\.recommendedTemplate\.id/);
assert.match(panel, /parsed\.version === 2 && parsed\.shotSetId/);
assert.match(panel, /这份脚本由旧版本生成/, '未声明版本的历史草稿继续走既有只读提示路径');
assert.doesNotMatch(panel, /await loadShotImages\(selectedShotSetId\)/, 'V3 生成成功后不得加载分镜图片');
assert.match(strategy, /目标总时长（包含封面）/);
assert.match(strategy, /口播正文约/);
assert.match(strategy, /minContentCharacters/);
assert.match(strategy, /视觉生成模型/);
assert.match(strategy, /p\.supportsVision/);
assert.match(strategy, /发送给该模型进行视觉理解/);
assert.match(panel, /p\.configured && p\.supportsVision/, '脚本生成模型必须默认选择已配置且支持视觉的供应商');
assert.match(panel, /script_material_mismatch/, '模板与图片不匹配时必须展示专用提示，不能误报为时长问题');
assert.match(panel, /materialReason/, '素材不匹配提示必须展示模型给出的图片不足原因');
assert.match(panel, /unsupportedNarrativeBeats/, '素材不匹配提示必须说明模板中缺少画面承接的阶段');
assert.match(result, /复制字幕稿/);
assert.match(result, /复制配音稿/);
assert.match(result, /完整字幕稿/);
assert.match(result, /完整配音稿（保留自然标点）/);
assert.match(picker, /SCRIPT_TEMPLATES/);
assert.match(creativePackage, /manifestScript/);
assert.match(creativePackage, /fullSubtitle/);
assert.match(creativePackage, /if \(isV3\)/);

console.log('script v3 UI contract tests passed');
