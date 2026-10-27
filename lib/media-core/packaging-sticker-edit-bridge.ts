export const PACKAGING_STICKER_EDIT_BRIDGE_JS = String.raw`
(function () {
  'use strict';
  if (window.__packagingStickerEditBridge) return;

  var SNAP_PX = 8;
  var MIN_WIDTH_PCT = 1;
  var MAX_WIDTH_PCT = 1000;
  var selected = null;
  var selectionEl = null;
  var scaleHandle = null;
  var rotateHandle = null;
  var guideXEl = null;
  var guideYEl = null;
  var tipEl = null;
  var session = null;
  var pending = null;
  var rafScheduled = false;
  var swallowClick = false;
  var swallowContextMenu = false;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function normDeg(v) { return ((v + 180) % 360 + 360) % 360 - 180; }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function rootRect() { return document.getElementById('root').getBoundingClientRect(); }
  function activeMode() {
    var mode = window.__stickerEditMode;
    return mode && mode.active && mode.only ? mode : null;
  }
  function getVars() {
    return window.compositionVariables
      || (window.__hyperframes && window.__hyperframes.getVariables && window.__hyperframes.getVariables())
      || {};
  }
  function modelFor(el) {
    if (!el) return null;
    var id = el.getAttribute('data-sticker-id');
    var vars = getVars();
    var sticker = (vars.stickers || []).find(function (item) { return item.id === id; });
    var asset = vars.stickerAssets && vars.stickerAssets[id];
    return sticker && asset ? { sticker: sticker, asset: asset } : null;
  }
  function stickerElement(id) {
    var all = document.querySelectorAll('.packaging-sticker[data-sticker-id]');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-sticker-id') === id) return all[i];
    return null;
  }
  function visible(el) {
    if (!el) return false;
    var style = getComputedStyle(el);
    var opacity = parseFloat(style.opacity);
    return style.display !== 'none' && style.visibility !== 'hidden' && (!isFinite(opacity) || opacity >= 0.05);
  }
  function hitSticker(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      if (!stack[i].closest) continue;
      var el = stack[i].closest('.packaging-sticker[data-sticker-id]');
      if (el && visible(el)) return el;
    }
    return null;
  }
  function hitCue(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      if (!stack[i].closest) continue;
      var el = stack[i].closest('[data-point-id^="cue:"]');
      if (el && visible(el)) return el.getAttribute('data-point-id').slice(4);
    }
    return '';
  }
  function centerScreen(sticker, rect) {
    return {
      x: rect.left + sticker.centerXPct / 100 * rect.width,
      y: rect.top + sticker.centerYPct / 100 * rect.height,
    };
  }
  function effectiveBox(sticker, asset, rect) {
    var bbox = asset.alpha_gt8_bbox;
    var bboxW = bbox[2] - bbox[0], bboxH = bbox[3] - bbox[1];
    var width = rect.width * sticker.visualWidthPct / 100;
    var height = width * bboxH / bboxW;
    var angle = sticker.rotationDeg * Math.PI / 180;
    var cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    var center = centerScreen(sticker, rect);
    return {
      cx: center.x - rect.left,
      cy: center.y - rect.top,
      width: cos * width + sin * height,
      height: sin * width + cos * height,
    };
  }

  function applyGeometry(el, target) {
    var model = modelFor(el);
    var runtime = window.__packagingStickerRuntime;
    if (!model || !runtime) return;
    var sticker = Object.assign({}, model.sticker, target);
    var geometry = runtime.computeStickerGeometry(sticker, model.asset);
    el.style.left = sticker.centerXPct + '%';
    el.style.top = sticker.centerYPct + '%';
    el.style.width = geometry.imageWidthPct + '%';
    var rotation = el.querySelector('.packaging-sticker-rotation');
    if (rotation) rotation.style.transform = 'rotate(' + sticker.rotationDeg + 'deg)';
  }
  function flushPending() {
    if (!pending) return;
    var next = pending;
    pending = null;
    applyGeometry(next.el, next.target);
    if (session) showTip(session.target);
  }
  function scheduleApply(el, target) {
    pending = { el: el, target: Object.assign({}, target) };
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () { rafScheduled = false; flushPending(); });
  }

  function ensureTip() {
    if (tipEl) return;
    tipEl = document.createElement('div');
    tipEl.style.cssText = 'position:fixed;z-index:2147483647;display:none;pointer-events:none;transform:translateX(-50%);'
      + 'padding:4px 8px;border-radius:6px;background:rgba(20,20,22,.88);color:#fff;font:11px/1.4 sans-serif;white-space:nowrap;';
    document.body.appendChild(tipEl);
  }
  function showTip(target) {
    ensureTip();
    var rect = rootRect();
    tipEl.textContent = 'X ' + target.centerXPct.toFixed(1) + '% · Y ' + target.centerYPct.toFixed(1) + '% · 宽 ' + target.visualWidthPct.toFixed(1) + '% · ' + target.rotationDeg.toFixed(0) + '°';
    tipEl.style.left = (rect.left + rect.width / 2) + 'px';
    tipEl.style.top = (rect.top + 8) + 'px';
    tipEl.style.display = 'block';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  function ensureGuides() {
    if (guideXEl && guideYEl) return;
    guideXEl = document.createElement('div');
    guideYEl = document.createElement('div');
    guideXEl.setAttribute('data-sticker-guide', 'x');
    guideYEl.setAttribute('data-sticker-guide', 'y');
    var common = 'position:fixed;z-index:2147483646;display:none;pointer-events:none;background:rgba(0,113,227,.9);box-shadow:0 0 0 .5px rgba(255,255,255,.65);';
    guideXEl.style.cssText = common + 'width:1px;';
    guideYEl.style.cssText = common + 'height:1px;';
    document.body.appendChild(guideXEl);
    document.body.appendChild(guideYEl);
  }
  function drawGuides(guides) {
    ensureGuides();
    var rect = rootRect();
    guideXEl.style.display = guides.x === null ? 'none' : 'block';
    guideYEl.style.display = guides.y === null ? 'none' : 'block';
    if (guides.x !== null) {
      guideXEl.style.left = (rect.left + guides.x) + 'px';
      guideXEl.style.top = rect.top + 'px';
      guideXEl.style.height = rect.height + 'px';
    }
    if (guides.y !== null) {
      guideYEl.style.left = rect.left + 'px';
      guideYEl.style.top = (rect.top + guides.y) + 'px';
      guideYEl.style.width = rect.width + 'px';
    }
  }
  function hideGuides() {
    if (guideXEl) guideXEl.style.display = 'none';
    if (guideYEl) guideYEl.style.display = 'none';
  }

  function snapMove(currentEl, target) {
    var model = modelFor(currentEl);
    var rect = rootRect();
    var box = effectiveBox(Object.assign({}, model.sticker, target), model.asset, rect);
    var rawX = target.centerXPct / 100 * rect.width;
    var rawY = target.centerYPct / 100 * rect.height;
    var candidatesX = [
      { value: rect.width / 2, guide: rect.width / 2 },
      { value: box.width / 2, guide: 0 },
      { value: rect.width - box.width / 2, guide: rect.width },
    ];
    var candidatesY = [
      { value: rect.height / 2, guide: rect.height / 2 },
      { value: box.height / 2, guide: 0 },
      { value: rect.height - box.height / 2, guide: rect.height },
    ];
    var all = document.querySelectorAll('.packaging-sticker[data-sticker-id]');
    for (var i = 0; i < all.length; i++) {
      var otherEl = all[i];
      if (otherEl === currentEl || !visible(otherEl)) continue;
      var otherModel = modelFor(otherEl);
      if (!otherModel) continue;
      var other = effectiveBox(otherModel.sticker, otherModel.asset, rect);
      var edgesX = [other.cx - other.width / 2, other.cx, other.cx + other.width / 2];
      var edgesY = [other.cy - other.height / 2, other.cy, other.cy + other.height / 2];
      for (var xi = 0; xi < edgesX.length; xi++) {
        var ex = edgesX[xi];
        candidatesX.push({ value: ex - box.width / 2, guide: ex }, { value: ex, guide: ex }, { value: ex + box.width / 2, guide: ex });
      }
      for (var yi = 0; yi < edgesY.length; yi++) {
        var ey = edgesY[yi];
        candidatesY.push({ value: ey - box.height / 2, guide: ey }, { value: ey, guide: ey }, { value: ey + box.height / 2, guide: ey });
      }
    }
    var bestX = null, bestY = null;
    for (var x = 0; x < candidatesX.length; x++) {
      var dx = Math.abs(candidatesX[x].value - rawX);
      if (dx <= SNAP_PX && (!bestX || dx < bestX.distance)) bestX = { distance: dx, value: candidatesX[x].value, guide: candidatesX[x].guide };
    }
    for (var y = 0; y < candidatesY.length; y++) {
      var dy = Math.abs(candidatesY[y].value - rawY);
      if (dy <= SNAP_PX && (!bestY || dy < bestY.distance)) bestY = { distance: dy, value: candidatesY[y].value, guide: candidatesY[y].guide };
    }
    if (bestX) target.centerXPct = clamp(bestX.value / rect.width * 100, 0, 100);
    if (bestY) target.centerYPct = clamp(bestY.value / rect.height * 100, 0, 100);
    return { x: bestX ? bestX.guide : null, y: bestY ? bestY.guide : null };
  }

  function deselect() {
    if (selectionEl && selectionEl.parentNode) selectionEl.parentNode.removeChild(selectionEl);
    selected = null;
    selectionEl = null;
    scaleHandle = null;
    rotateHandle = null;
    session = null;
    pending = null;
    hideGuides();
    hideTip();
  }
  function syncSelection() {
    var mode = activeMode();
    if (!mode) { deselect(); return; }
    var el = stickerElement(mode.only);
    var model = modelFor(el);
    if (!el || !model) { deselect(); return; }
    if (selected === el && selectionEl) return;
    deselect();
    selected = el;
    var rotation = el.querySelector('.packaging-sticker-rotation');
    var bbox = model.asset.alpha_gt8_bbox;
    selectionEl = document.createElement('div');
    selectionEl.setAttribute('data-sticker-edit-ui', '1');
    selectionEl.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483645;outline:1.5px dashed rgba(0,113,227,.95);outline-offset:3px;'
      + 'left:' + (bbox[0] / model.asset.width * 100) + '%;top:' + (bbox[1] / model.asset.height * 100) + '%;'
      + 'width:' + ((bbox[2] - bbox[0]) / model.asset.width * 100) + '%;height:' + ((bbox[3] - bbox[1]) / model.asset.height * 100) + '%;';
    scaleHandle = document.createElement('div');
    scaleHandle.setAttribute('data-sticker-handle', 'scale');
    scaleHandle.title = '拖动等比缩放';
    scaleHandle.style.cssText = 'position:absolute;right:-8px;bottom:-8px;width:12px;height:12px;border:2px solid #fff;border-radius:3px;'
      + 'background:#0071e3;box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:auto;cursor:nwse-resize;touch-action:none;';
    rotateHandle = document.createElement('div');
    rotateHandle.setAttribute('data-sticker-handle', 'rotate');
    rotateHandle.title = '拖动旋转';
    rotateHandle.style.cssText = 'position:absolute;left:50%;top:-25px;width:14px;height:14px;border:2px solid #fff;border-radius:50%;'
      + 'background:#0071e3;box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:auto;cursor:grab;touch-action:none;transform:translateX(-50%);';
    selectionEl.appendChild(scaleHandle);
    selectionEl.appendChild(rotateHandle);
    rotation.appendChild(selectionEl);
  }

  function startSession(kind, el, event) {
    var model = modelFor(el);
    var rect = rootRect();
    var initial = {
      centerXPct: model.sticker.centerXPct,
      centerYPct: model.sticker.centerYPct,
      visualWidthPct: model.sticker.visualWidthPct,
      rotationDeg: model.sticker.rotationDeg,
    };
    var center = centerScreen(initial, rect);
    session = {
      kind: kind,
      el: el,
      pointerId: event.pointerId,
      initial: initial,
      target: Object.assign({}, initial),
      startClientX: event.clientX,
      startClientY: event.clientY,
      centerX: center.x,
      centerY: center.y,
      startDistance: Math.max(1, Math.hypot(event.clientX - center.x, event.clientY - center.y)),
      startAngle: Math.atan2(event.clientY - center.y, event.clientX - center.x),
      moved: false,
    };
    var capture = kind === 'scale' ? scaleHandle : kind === 'rotate' ? rotateHandle : el;
    try { capture.setPointerCapture(event.pointerId); } catch (error) {}
  }
  function onPointerMove(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    var target = session.target;
    if (session.kind === 'move') {
      var rect = rootRect();
      target.centerXPct = clamp(session.initial.centerXPct + (event.clientX - session.startClientX) / rect.width * 100, 0, 100);
      target.centerYPct = clamp(session.initial.centerYPct + (event.clientY - session.startClientY) / rect.height * 100, 0, 100);
      drawGuides(snapMove(session.el, target));
    } else if (session.kind === 'scale') {
      var distance = Math.max(1, Math.hypot(event.clientX - session.centerX, event.clientY - session.centerY));
      target.visualWidthPct = clamp(session.initial.visualWidthPct * distance / session.startDistance, MIN_WIDTH_PCT, MAX_WIDTH_PCT);
      hideGuides();
    } else {
      var angle = Math.atan2(event.clientY - session.centerY, event.clientX - session.centerX);
      target.rotationDeg = normDeg(session.initial.rotationDeg + (angle - session.startAngle) * 180 / Math.PI);
      hideGuides();
    }
    session.moved = true;
    scheduleApply(session.el, target);
    showTip(target);
  }
  function commitSession() {
    if (!session) return;
    var current = session;
    session = null;
    flushPending();
    hideGuides();
    hideTip();
    if (!current.moved) return;
    swallowClick = true;
    try {
      var parent = window.parent;
      if (parent && typeof parent.__packagingStickerEditCommit === 'function') {
        parent.__packagingStickerEditCommit(current.el.getAttribute('data-sticker-id'), {
          centerXPct: round3(current.target.centerXPct),
          centerYPct: round3(current.target.centerYPct),
          visualWidthPct: round3(current.target.visualWidthPct),
          rotationDeg: round3(current.target.rotationDeg),
        });
      }
    } catch (error) {}
  }
  function cancelSession() {
    if (!session) return;
    var current = session;
    session = null;
    pending = null;
    if (current.el.isConnected) applyGeometry(current.el, current.initial);
    hideGuides();
    hideTip();
  }
  function onPointerUp(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    commitSession();
  }
  function onPointerCancel(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelSession();
  }
  function onPointerDown(event) {
    if (event.button === 2 && session) {
      event.preventDefault();
      event.stopPropagation();
      swallowContextMenu = true;
      cancelSession();
      return;
    }
    flushPending();
    var mode = activeMode();
    if (!mode || event.button !== 0) return;
    var stack = document.elementsFromPoint(event.clientX, event.clientY);
    var handle = '';
    for (var i = 0; i < stack.length; i++) {
      if (stack[i].getAttribute && stack[i].getAttribute('data-sticker-handle')) { handle = stack[i].getAttribute('data-sticker-handle'); break; }
    }
    if (handle && selected) {
      event.preventDefault();
      event.stopPropagation();
      startSession(handle, selected, event);
      return;
    }
    var el = hitSticker(event.clientX, event.clientY);
    if (!el) {
      var cueId = hitCue(event.clientX, event.clientY);
      deselect();
      try {
        if (cueId && window.parent && typeof window.parent.__packagingEditCueSelect === 'function') window.parent.__packagingEditCueSelect(cueId);
        else if (window.parent && typeof window.parent.__packagingStickerEditExit === 'function') window.parent.__packagingStickerEditExit();
      } catch (error) {}
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (el !== selected) {
      deselect();
      try { if (window.parent && typeof window.parent.__packagingStickerEditSelect === 'function') window.parent.__packagingStickerEditSelect(el.getAttribute('data-sticker-id')); } catch (error) {}
      return;
    }
    startSession('move', el, event);
  }
  function onClickCapture(event) {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }
  function onContextMenu(event) {
    if (!activeMode() && !session && !swallowContextMenu) return;
    swallowContextMenu = false;
    event.preventDefault();
    event.stopPropagation();
    if (session) cancelSession();
  }

  window.__packagingStickerEditBridge = {
    sync: syncSelection,
    cancel: cancelSession,
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('click', onClickCapture, true);
})();
`;
