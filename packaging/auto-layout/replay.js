/* 重放规范布局服务的不可变结果；普通浏览器不重新求解自动布局。 */
(function (global) {
  'use strict';
  function vars() {
    return global.compositionVariables
      || (global.__hyperframes && global.__hyperframes.getVariables && global.__hyperframes.getVariables())
      || {};
  }
  function resolution() {
    var value = vars().layoutResolution;
    return value && value.status === 'resolved' && value.elements ? value : null;
  }
  function numeric(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  // px 字号按 root/output 换算；手账模板保存的 cqw 则直接按当前 root 宽度求值。
  // 正式导出时 rootWidth === outputWidth，两种单位都不会改变已冻结任务的导出几何。
  function previewFontSize(value, resolved) {
    var raw = String(value).trim();
    var size = Number.parseFloat(raw);
    var root = global.document && global.document.getElementById('root');
    var rootWidth = root ? (root.clientWidth || root.getBoundingClientRect().width) : 0;
    if (!Number.isFinite(size) || !(rootWidth > 0)) return raw;
    if (raw.endsWith('cqw')) return String(size * rootWidth / 100) + 'px';
    if (!(resolved.outputWidth > 0)) return raw;
    return String(size * rootWidth / resolved.outputWidth) + 'px';
  }
  function apply() {
    var resolved = resolution();
    if (!resolved || !global.document) return false;
    var elements = resolved.elements;
    var missing = [];
    Object.keys(elements).forEach(function (id) {
      var item = elements[id];
      if (!item) return;
      if (item.kind === 'pointCue') {
        var point = global.document.querySelector('[data-point-id="cue:' + id + '"]');
        if (!point) { missing.push(id); return; }
        if (item.fit && item.fit.fontSize) point.style.fontSize = previewFontSize(item.fit.fontSize, resolved);
        var text = point.querySelector('.txt,.ptxt');
        if (text && item.fit && item.fit.textFontSize) text.style.fontSize = previewFontSize(item.fit.textFontSize, resolved);
        // 手动布局优先：模板 applyPointLayout 对非空布局会置 dataset.ul='1'（含拖动中的 liveLayouts 与载入期 L.cues）。
        // 此类元素的位置由模板布局桥负责，旧 Resolution 不得在 refit 时把用户拖到的位置盖回去；字号仍按 Resolution 重放。
        if (point.dataset && point.dataset.ul === '1') return;
        if (global.__pointLayout && typeof global.__pointLayout.apply === 'function') {
          global.__pointLayout.apply(point, {
            x: item.fit ? numeric(item.fit.bridgeX, item.centerXPct) : item.centerXPct,
            y: item.fit ? numeric(item.fit.bridgeY, item.centerYPct) : item.centerYPct,
            scale: item.fit ? numeric(item.fit.zoom, 1) : 1,
            rotate: item.fit ? numeric(item.fit.rotate, 0) : 0,
          });
        } else {
          point.style.left = item.centerXPct + '%';
          point.style.top = item.centerYPct + '%';
        }
      } else if (item.kind === 'sticker') {
        var sticker = global.document.querySelector('.packaging-sticker[data-sticker-id="' + id + '"]');
        if (!sticker) { missing.push(id); return; }
        // 贴纸编辑桥在本次文档内已接管几何时（拖动/缩放/旋转），保留用户位置，等待新 Resolution 重载后再统一重放。
        if (sticker.dataset && sticker.dataset.stickerEdited === '1') return;
        sticker.style.left = item.centerXPct + '%';
        sticker.style.top = item.centerYPct + '%';
      }
    });
    if (missing.length) {
      global.__packagingLayoutReady = {
        status: 'error',
        message: '布局元素尚未就绪：' + missing.join(','),
        inputHash: resolved.inputHash,
        geometryManifestHash: resolved.geometryManifestHash,
      };
      return false;
    }
    global.__packagingLayoutReady = {
      status: 'resolved',
      inputHash: resolved.inputHash,
      geometryManifestHash: resolved.geometryManifestHash,
    };
    return true;
  }
  var api = {
    apply: apply,
    getCenter: function (id) {
      var resolved = resolution();
      var item = resolved && resolved.elements[id];
      return item ? { x: item.centerXPct, y: item.centerYPct } : null;
    },
    getResolution: resolution,
  };
  global.__packagingAutoLayoutReplay = api;
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', apply, { once: true });
    else apply();
    global.setTimeout(apply, 0);
  }
})(typeof window !== 'undefined' ? window : null);
