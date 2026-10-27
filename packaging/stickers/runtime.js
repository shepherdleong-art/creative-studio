/* 共享 overlay 贴纸运行时：四模板复用；预览与 HyperFrames 导出驱动同一条 GSAP 时间线。 */
(function (global) {
  'use strict';

  var FPS = 24;

  function computeStickerGeometry(sticker, asset) {
    var bbox = asset && asset.alpha_gt8_bbox;
    if (!asset || !Array.isArray(bbox) || bbox.length !== 4) throw new Error('贴纸 ' + sticker.id + ' 缺少有效包围框');
    var left = bbox[0], top = bbox[1], right = bbox[2], bottom = bbox[3];
    var bboxWidth = right - left, bboxHeight = bottom - top;
    if (!(asset.width > 0 && asset.height > 0 && bboxWidth > 0 && bboxHeight > 0)) throw new Error('贴纸 ' + sticker.id + ' 的素材几何无效');
    if (!(sticker.visualWidthPct > 0)) throw new Error('贴纸 ' + sticker.id + ' 的视觉宽度无效');
    var centerX = (left + right) / 2;
    var centerY = (top + bottom) / 2;
    return {
      imageWidthPct: sticker.visualWidthPct * asset.width / bboxWidth,
      translateXPct: -centerX / asset.width * 100,
      translateYPct: -centerY / asset.height * 100,
      originXPct: centerX / asset.width * 100,
      originYPct: centerY / asset.height * 100,
    };
  }

  function mountPackagingStickers(options) {
    options = options || {};
    var doc = options.document || (global && global.document);
    if (!doc) throw new Error('贴纸运行时缺少 document');
    var root = options.root || doc.getElementById('root');
    if (!root) throw new Error('贴纸运行时缺少 #root');
    var host = options.host || doc.getElementById('sticker-layer');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'sticker-layer';
      root.appendChild(host);
    }
    var vars = options.vars || (global && global.compositionVariables)
      || (global && global.__hyperframes && global.__hyperframes.getVariables && global.__hyperframes.getVariables())
      || {};
    var stickers = Array.isArray(vars.stickers) ? vars.stickers : [];
    var assets = vars.stickerAssets && typeof vars.stickerAssets === 'object' ? vars.stickerAssets : {};
    host.replaceChildren();
    var elements = new Map();
    if (stickers.length === 0) return { host: host, elements: elements };
    var timeline = options.timeline || (global && global.__timelines && global.__timelines.overlay);
    if (!timeline || typeof timeline.set !== 'function') throw new Error('贴纸运行时未找到 overlay GSAP 时间线');

    stickers.forEach(function (sticker) {
      var asset = assets[sticker.id];
      if (!asset) throw new Error('贴纸 ' + sticker.id + ' 缺少已解析素材');
      var geometry = computeStickerGeometry(sticker, asset);
      var outer = doc.createElement('div');
      outer.className = 'packaging-sticker';
      outer.dataset.stickerId = sticker.id;
      outer.style.position = 'absolute';
      outer.style.left = sticker.centerXPct + '%';
      outer.style.top = sticker.centerYPct + '%';
      outer.style.width = geometry.imageWidthPct + '%';
      outer.style.transform = 'translate(' + geometry.translateXPct + '%,' + geometry.translateYPct + '%)';
      outer.style.opacity = '0';
      outer.style.zIndex = String(1000 - sticker.trackIndex);
      outer.style.pointerEvents = 'auto';

      var rotation = doc.createElement('div');
      rotation.className = 'packaging-sticker-rotation';
      rotation.style.transform = 'rotate(' + sticker.rotationDeg + 'deg)';
      rotation.style.transformOrigin = geometry.originXPct + '% ' + geometry.originYPct + '%';
      var motion = doc.createElement('div');
      motion.className = 'packaging-sticker-motion';
      motion.style.transformOrigin = geometry.originXPct + '% ' + geometry.originYPct + '%';
      var image = doc.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.decoding = 'sync';
      image.style.display = 'block';
      image.style.width = '100%';
      image.style.height = 'auto';
      image.style.userSelect = 'none';
      image.src = 'stickers/' + String(asset.file).split('/').map(encodeURIComponent).join('/');

      motion.appendChild(image);
      rotation.appendChild(motion);
      outer.appendChild(rotation);
      host.appendChild(outer);
      elements.set(sticker.id, outer);

      // C3 静态闭环：只注册整帧可见性；组合动效在 C5 共享此宿主与时间线。
      timeline.set(outer, { opacity: 0 }, 0);
      timeline.set(outer, { opacity: 1 }, sticker.startFrame / FPS);
      timeline.set(outer, { opacity: 0 }, sticker.endFrame / FPS);
    });
    return { host: host, elements: elements };
  }

  var api = { FPS: FPS, computeStickerGeometry: computeStickerGeometry, mount: mountPackagingStickers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global) {
    global.__packagingStickerRuntime = api;
    if (global.document) api.mount();
  }
})(typeof window !== 'undefined' ? window : null);
