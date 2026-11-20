/* 共享 overlay 贴纸运行时：四模板复用；预览与 HyperFrames 导出驱动同一条 GSAP 时间线。 */
(function (global) {
  'use strict';

  var FPS = 24;
  var ANIMATION_PRESETS = {
    soft: { enterFrames: 7, exitFrames: 6 },
    bounce: { enterFrames: 9, exitFrames: 6 },
    rise: { enterFrames: 8, exitFrames: 6 },
    slide: { enterFrames: 8, exitFrames: 6 },
    zoom: { enterFrames: 8, exitFrames: 6 },
    none: { enterFrames: 0, exitFrames: 0 },
  };
  var TEMPLATE_ANIMATIONS = {
    'overlay-poster': 'bounce',
    'overlay-journal': 'soft',
    'overlay-minimal': 'soft',
    'overlay-variety': 'bounce',
  };

  function resolveStickerAnimation(animation, template) {
    if (animation !== 'follow-template') return ANIMATION_PRESETS[animation] ? animation : 'none';
    var resolved = TEMPLATE_ANIMATIONS[template];
    if (!resolved) throw new Error('跟随模板动效缺少有效包装模板');
    return resolved;
  }

  function planStickerAnimation(sticker, template) {
    var durationFrames = sticker.endFrame - sticker.startFrame;
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 4) throw new Error('贴纸 ' + sticker.id + ' 的动画时长至少为 4 帧');
    var animation = resolveStickerAnimation(sticker.animation, template);
    var preset = ANIMATION_PRESETS[animation];
    var enterFrames = preset.enterFrames;
    var exitFrames = preset.exitFrames;
    if (animation !== 'none' && enterFrames + exitFrames > durationFrames - 2) {
      var available = durationFrames - 2;
      var scale = available / (enterFrames + exitFrames);
      enterFrames = Math.max(1, Math.round(preset.enterFrames * scale));
      exitFrames = Math.max(1, Math.round(preset.exitFrames * scale));
      while (enterFrames + exitFrames > available) {
        if (enterFrames > 1 && enterFrames / preset.enterFrames >= exitFrames / preset.exitFrames) enterFrames -= 1;
        else exitFrames -= 1;
      }
      while (enterFrames + exitFrames < available) {
        if (enterFrames / preset.enterFrames < exitFrames / preset.exitFrames) enterFrames += 1;
        else exitFrames += 1;
      }
    }
    return {
      animation: animation,
      enterFrames: enterFrames,
      exitFrames: exitFrames,
      stableFrames: durationFrames - enterFrames - exitFrames,
      exitStartFrame: sticker.endFrame - exitFrames,
    };
  }

  function animationMotion(animation, entering) {
    if (animation === 'soft') return entering ? { x: 0, y: 18, scale: 1 } : { x: 0, y: -8, scale: 1 };
    if (animation === 'bounce') return entering ? { x: 0, y: 0, scale: 0.72 } : { x: 0, y: 0, scale: 0.86 };
    if (animation === 'rise') return entering ? { x: 0, y: 56, scale: 1 } : { x: 0, y: 48, scale: 1 };
    if (animation === 'slide') return entering ? { x: -72, y: 0, scale: 1 } : { x: 72, y: 0, scale: 1 };
    if (animation === 'zoom') return entering ? { x: 0, y: 0, scale: 0.6 } : { x: 0, y: 0, scale: 0.75 };
    return { x: 0, y: 0, scale: 1 };
  }

  function animationEase(animation, entering) {
    if (animation === 'bounce' && entering) return 'back.out(1.8)';
    return entering ? 'power2.out' : 'power2.in';
  }

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
    var template = options.template || vars.stickerTemplate;

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

      var plan = planStickerAnimation(sticker, template);
      var enterSec = plan.enterFrames / FPS;
      var exitSec = plan.exitFrames / FPS;
      timeline.set(outer, { opacity: 0 }, 0);
      timeline.set(motion, animationMotion(plan.animation, true), 0);
      if (plan.animation === 'none') {
        timeline.set(outer, { opacity: 1 }, sticker.startFrame / FPS);
      } else {
        timeline.to(outer, { opacity: 1, duration: enterSec, ease: animationEase(plan.animation, true) }, sticker.startFrame / FPS);
        timeline.to(motion, { x: 0, y: 0, scale: 1, duration: enterSec, ease: animationEase(plan.animation, true) }, sticker.startFrame / FPS);
        timeline.to(outer, { opacity: 0, duration: exitSec, ease: animationEase(plan.animation, false) }, plan.exitStartFrame / FPS);
        timeline.to(motion, Object.assign(animationMotion(plan.animation, false), { duration: exitSec, ease: animationEase(plan.animation, false) }), plan.exitStartFrame / FPS);
      }
      // endFrame 为开区间：显式终点 set 保证逐帧 seek 与导出都不会多出一帧。
      timeline.set(outer, { opacity: 0 }, sticker.endFrame / FPS);
    });
    return { host: host, elements: elements };
  }

  var api = {
    FPS: FPS,
    computeStickerGeometry: computeStickerGeometry,
    resolveStickerAnimation: resolveStickerAnimation,
    planStickerAnimation: planStickerAnimation,
    mount: mountPackagingStickers,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global) {
    global.__packagingStickerRuntime = api;
    if (global.document) api.mount();
  }
})(typeof window !== 'undefined' ? window : null);
