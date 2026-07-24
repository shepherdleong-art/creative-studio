import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/mixcut/MixcutPanel.tsx', 'utf8');
const sidebar = fs.readFileSync('components/mixcut/MixcutSidebar.tsx', 'utf8');
const materialStep = fs.readFileSync('components/mixcut/MaterialStep.tsx', 'utf8');
const styles = fs.readFileSync('components/mixcut/MixcutPanel.module.css', 'utf8');
const page = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');

assert.match(page, /mixcut=v1|searchParams\.get\('mixcut'\)/, 'Phase 1 正式 UI 必须有不替换旧第五步的可达入口');
assert.match(page, /<MixcutPanel projectId=/, '项目页必须挂载真实 MixcutPanel');
assert.match(panel, /\/api\/projects\/\$\{projectId\}\/final-edit\/context/, 'MixcutPanel 必须读取真实 context API');
assert.match(panel, /AbortController/, '快速切组必须取消旧请求，防止迟到响应覆盖当前组');
assert.match(panel, /initializeMaterialSelection/, '素材默认选择必须通过按 shotSetId 隔离的领域函数');
assert.match(panel, /materialSelectionForShotSet/, '渲染素材选择时必须只读取当前 shotSetId');
assert.match(panel, /externalByShotSet/, '外部素材必须按 shotSetId 分桶保存');
assert.match(panel, /targetShotSetId/, '上传开始时必须捕获目标分镜组，切组后不能把响应合并到当前组');
assert.match(panel, /external:\$\{asset\.id\}/, '外部素材必须使用 namespaced asset key');
assert.match(panel, /data-mixcut-shot-set-id/, '正式表面必须暴露当前分镜组供浏览器门禁验证');
assert.match(sidebar, /succeededVideoCount/);
assert.match(sidebar, /totalDurationUs/);
assert.match(sidebar, /其他分镜组不会混入/, '左辅栏必须明确当前组隔离规则');
assert.match(materialStep, /source === 'module4'/, '模块 4 素材必须显示真实来源标记');
assert.match(materialStep, /\.mp4,.mov,.avi,.webm/, '外部素材入口只接受 V1 锁定的视频格式');
assert.doesNotMatch(materialStep, /JPG|PNG|图片/, 'V1 已否决静态图片导入，正式 MaterialStep 不得重新出现图片入口');
assert.match(materialStep, /当前组还没有可用视频/, '空分镜组必须显示明确阻断提示');
assert.match(styles, /min-width:\s*0/, '主工作区 grid child 必须允许收缩，避免文字和卡片越界');
assert.match(styles, /overflow-y:\s*auto/, '素材区必须可独立滚动');

console.log('final-edit mixcut UI contract tests passed');
