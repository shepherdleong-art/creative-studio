import assert from 'node:assert/strict';
import { packagingPreviewHtml } from '../lib/media-core/packaging-preview.ts';
import { STICKER_STYLE_BY_TEMPLATE, type PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';
import { PACKAGING_TEMPLATE_IDS, type FinalEditPackagingConfig, type PackagingVars } from '../lib/media-core/packaging-vars.ts';

const vars: PackagingVars = {
  title: '标题', subtitle: '副标题', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '',
};

function sticker(template: FinalEditPackagingConfig['template']): PackagingStickerInstance {
  return {
    id: `sticker_${template}`,
    assetId: 'recommend',
    styleMode: 'follow-template',
    fixedStyle: null,
    startFrame: 20,
    endFrame: 68,
    centerXPct: 50,
    centerYPct: 50,
    visualWidthPct: 30,
    rotationDeg: 0,
    trackIndex: 0,
    animation: 'bounce',
    origin: { kind: 'manual' },
  };
}

for (const template of PACKAGING_TEMPLATE_IDS) {
  const config: FinalEditPackagingConfig = {
    enabled: true,
    template,
    varsOverrides: {},
    stickers: [sticker(template)],
    stickerDefaults: { animation: 'soft' },
  };
  const html = packagingPreviewHtml({ config, vars, totalSec: 10, coverSec: 20 / 24, edit: true });
  assert.ok(html.includes('"stickers"'), `${template} 预览必须注入贴纸实例`);
  assert.ok(html.includes('"stickerDefaults"'), `${template} 预览必须注入默认动效`);
  assert.ok(html.includes('"stickerAssets"'), `${template} 预览必须注入解析素材`);
  assert.ok(html.includes(`"file":"${STICKER_STYLE_BY_TEMPLATE[template]}/recommend.png"`), `${template} 必须解析自己风格的原始 PNG`);
  assert.ok(html.includes('"stickerTemplate"'), `${template} 预览必须注入 follow-template 解析模板`);
  assert.ok(html.includes('window.__packagingStickerEditBridge'), `${template} 编辑预览必须注入贴纸编辑桥`);
  assert.ok(html.includes('stickers/runtime.js'), `${template} 必须继续使用共享贴纸运行时`);

  const readonlyHtml = packagingPreviewHtml({ config, vars, totalSec: 10, coverSec: 20 / 24, edit: false });
  assert.ok(!readonlyHtml.includes('window.__packagingStickerEditBridge'), '只读预览不得开启贴纸编辑桥');
}

const empty = packagingPreviewHtml({
  config: { enabled: true, template: 'overlay-poster', varsOverrides: {} },
  vars,
  totalSec: 10,
  coverSec: 20 / 24,
  edit: true,
});
assert.ok(!empty.includes('"stickerAssets"'), '无贴纸旧配置不得生成素材映射');

console.log('批量包装贴纸预览测试通过：四模板实例、默认值、原图、编辑桥与旧配置兼容。');
