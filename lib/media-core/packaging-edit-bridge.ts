export const PACKAGING_EDIT_BRIDGE_JS = `(function () {
  'use strict';
  // 幂等守卫：重复注入不再叠加任何监听
  if (window.__packagingEditBridge) return;

  var MIN_SCALE = 0.3;      // 缩放倍率下限（与模板/服务端清洗口径一致）
  var MAX_SCALE = 3;        // 缩放倍率上限
  var HANDLE_PX = 12;       // 角点缩放手柄边长（px）
  var EDGE_TOL = 4;         // 移动钳制允许的可视误差（px）
  var FLIP_TOP_PX = 28;     // 贴顶阈值：元素可视上缘距画布小于此值时，旋转手柄改挂右下角内侧
  var WHEEL_STEP = 1.08;    // 滚轮每格缩放步进倍率
  var WHEEL_THROTTLE = 120; // 滚轮缩放应用节流（ms）
  var WHEEL_COMMIT = 300;   // 滚轮停歇判定：超过此间隔无事件即提交一次（ms）

  var selected = null;        // 当前处于编辑态（选中）的元素
  var handleEl = null;        // 角点缩放手柄（挂元素右下角外侧，随元素移动）
  var resetEl = null;         // 单条复位按钮「↺」（挂元素左上角外侧）
  var rotateEl = null;        // 旋转手柄「↻」（默认右上角外侧，贴顶时改挂右下角内侧）
  var tipEl = null;           // 实时数值浮层（挂 body 用 fixed 定位，不受元素 zoom 影响）
  var session = null;         // 进行中的指针手势会话（move / scale / rotate）
  var wheelSession = null;    // 进行中的滚轮手势状态（首次滚动建立，停歇提交后清除）
  var savedStyle = null;      // 进入编辑态前的行内样式，退出时还原
  var swallowClick = false;   // 手势结束后吞掉紧随的 click，防穿透误触发模板交互
  var lastWheelApply = 0;     // 上次滚轮缩放实际应用的时间戳（节流用）
  var wheelTimer = 0;         // 滚轮停歇提交定时器
  var pendingLayout = null;   // rAF 节流：待应用的最新目标 {el,x,y,scale,rotate}
  var rafScheduled = false;   // 是否已有 rAF 回调在排队

  // ---------- 基础工具 ----------

  // 读取父页面下发的编辑模式 { active:boolean, only:string|null }；未激活返回 null（每次手势开始实时读）
  function activeMode() {
    var m = window.__editMode;
    return m && m.active ? m : null;
  }

  // 画布矩形：优先模板挂载点 #root，退化为 documentElement
  function canvasRect() {
    var root = document.getElementById('root');
    return (root || document.documentElement).getBoundingClientRect();
  }

  // 提交数值统一保留 1 位小数
  function round1(n) { return Math.round(n * 10) / 10; }

  // 命中可编辑元素：only 非空时仅放行 data-point-id 匹配的元素；
  // 不可见元素（display:none / visibility:hidden / opacity<0.05）视为不可编辑——
  // 防止封面段里未入场的正片卖点（opacity:0）拦截点击；
  // 空文案卖点 display:none 天然不可命中；抓取失败的占位标题（data-placeholder）编辑态可见，与有字元素同套交互
  function hitEditable(target, m) {
    if (!target || typeof target.closest !== 'function') return null;
    var el = target.closest('[data-point-id]');
    if (!el) return null;
    if (m.only && el.getAttribute('data-point-id') !== m.only) return null;
    var cs = window.getComputedStyle(el);
    var opacity = parseFloat(cs.opacity);
    if (!isFinite(opacity)) opacity = 1;
    if (cs.display === 'none' || cs.visibility === 'hidden' || opacity < 0.05) return null;
    return el;
  }

  // 数值钳到 [lo, hi]
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // 角度规范化到 -180~180
  function normDeg(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

  // 元素当前 zoom 倍率：行内 zoom 缺失/非法时按 1 计（仅作手势初值；手势期间用手势内变量跟踪，不 re-read）
  function readZoom(el) {
    var z = parseFloat(el.style.zoom);
    return (isFinite(z) && z > 0) ? z : 1;
  }

  // 元素当前旋转角：读 CSS rotate 独立属性（度数；与 transform 里的 translate(-50%,-50%) 互不干扰），缺失按 0 计
  function readRotate(el) {
    var d = parseFloat(el.style.rotate);
    return isFinite(d) ? normDeg(d) : 0;
  }

  // 元素可视中心占画布的百分比（与模板端 apply 的测量同口径：屏幕坐标对画布矩形归一化，
  // 外层预览缩放对分子分母同倍缩放自动约掉）。getBoundingClientRect 返回旋转后外接框，
  // 其中心 = 旋转中心 = 元素可视中心，天然正确
  function centerPct(el, rootRect) {
    var r = el.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2 - rootRect.left) / rootRect.width * 100,
      y: (r.top + r.height / 2 - rootRect.top) / rootRect.height * 100
    };
  }

  // 读取当前布局 {x,y,scale,rotate}：提交回传与复位后同步手柄用（手势期间的目标值不走这里，用手势内变量）
  function readLayout(el) {
    var rootRect = canvasRect();
    var c = centerPct(el, rootRect);
    return { x: c.x, y: c.y, scale: readZoom(el), rotate: readRotate(el) };
  }

  // 手柄/复位钮/旋转柄是元素子节点会随 zoom 缩放，反向补偿保持可操作尺寸
  function syncHandleZoom(scale) {
    var inv = String(1 / scale);
    if (handleEl) handleEl.style.zoom = inv;
    if (resetEl) resetEl.style.zoom = inv;
    if (rotateEl) rotateEl.style.zoom = inv;
  }

  // ---------- 布局应用：全部委托模板端 __pointLayout.apply ----------

  // 模板端契约检查：apply 缺失时静默不拖（防御；契约模板必带，缺失说明模板未按契约实现）
  function hasApply() {
    return !!(window.__pointLayout && typeof window.__pointLayout.apply === 'function');
  }

  // 同步应用一次目标布局。apply 自带中心锚定（量中心→写内联 px 偏移→复测→按实测位移斜率精修）：
  // 给它目标中心坐标，zoom/rotate/包含块/祖先缩放的全部几何由模板端闭环处理
  function applyLayout(el, layout) {
    try {
      if (hasApply()) window.__pointLayout.apply(el, layout);
    } catch (err) {}
  }

  // rAF 节流：move 事件只存最新目标，每帧最多执行一次 apply
  // （apply 内有多次同步布局测量，pointermove 频率直调会抖动/占满主线程）
  function scheduleApply(el, layout) {
    pendingLayout = { el: el, x: layout.x, y: layout.y, scale: layout.scale, rotate: layout.rotate };
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      flushPending();
    });
  }

  // 立即落地未应用的最后一帧目标（手势结束提交前必须先落地，保证按最终状态测量回传）
  function flushPending() {
    if (!pendingLayout) return;
    var p = pendingLayout;
    pendingLayout = null;
    applyLayout(p.el, { x: p.x, y: p.y, scale: p.scale, rotate: p.rotate });
    if (selected) clampHandles(); // 缩放/旋转改变手柄视口落点，逐帧复钳
  }

  // ---------- 浮层 / 选中态 ----------

  // 实时数值浮层：「中心 x%, y% · 缩放xx%[ · 旋转xx°]」（无旋转不显示旋转段），跟随元素上方，顶部放不下时改放下方
  function showTip(el, layout) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.style.cssText = 'position:fixed;z-index:2147483647;display:none;pointer-events:none;'
        + 'background:rgba(15,23,42,.92);color:#fff;font:12px/1.5 sans-serif;'
        + 'padding:2px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,0);';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = '中心 ' + round1(layout.x) + '%, ' + round1(layout.y) + '% · 缩放' + Math.round(layout.scale * 100) + '%'
      + (layout.rotate ? ' · 旋转' + Math.round(layout.rotate) + '°' : '');
    var r = el.getBoundingClientRect();
    var top = r.top - 30;
    if (top < 4) top = r.bottom + 8;
    tipEl.style.left = (r.left + r.width / 2) + 'px';
    tipEl.style.top = top + 'px';
    tipEl.style.display = 'block';
  }

  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  // 进入编辑态：虚线高亮 + 角点缩放手柄 + 旋转手柄 + 单条复位按钮
  function select(el) {
    if (selected === el) return;
    deselect();
    selected = el;
    savedStyle = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, touchAction: el.style.touchAction };
    el.style.outline = '2px dashed rgba(59,130,246,.9)';
    el.style.outlineOffset = '3px';
    el.style.touchAction = 'none';
    // 边缘翻转：贴顶（可视上缘距画布 < FLIP_TOP_PX）时旋转手柄挂右下角内侧、缩放柄外移避让；
    // 否则挂右上角外侧（复位钮固定挂左上角外侧，不与旋转手柄抢位置）
    var nearTop = el.getBoundingClientRect().top - canvasRect().top < FLIP_TOP_PX;
    handleEl = document.createElement('div');
    handleEl.title = '拖拽缩放';
    handleEl.style.cssText = 'position:absolute;' + (nearTop ? 'right:-14px;bottom:-14px;' : 'right:-8px;bottom:-8px;')
      + 'width:' + HANDLE_PX + 'px;height:' + HANDLE_PX + 'px;'
      + 'background:#3b82f6;border:2px solid #fff;border-radius:3px;'
      + 'cursor:nwse-resize;z-index:2147483647;pointer-events:auto;touch-action:none;';
    el.appendChild(handleEl);
    resetEl = document.createElement('div');
    resetEl.title = '恢复默认版式';
    resetEl.textContent = '↺';
    resetEl.style.cssText = 'position:absolute;top:-10px;left:-10px;width:18px;height:18px;'
      + 'background:#fff;color:#3b82f6;border:1px solid #3b82f6;border-radius:50%;'
      + 'font:13px/16px sans-serif;text-align:center;cursor:pointer;user-select:none;'
      + 'z-index:2147483647;pointer-events:auto;touch-action:none;';
    el.appendChild(resetEl);
    rotateEl = document.createElement('div');
    rotateEl.title = '拖拽旋转';
    rotateEl.textContent = '↻';
    rotateEl.style.cssText = 'position:absolute;width:18px;height:18px;' + (nearTop ? 'right:4px;bottom:4px;' : 'top:-10px;right:-10px;')
      + 'background:#fff;color:#3b82f6;border:1px solid #3b82f6;border-radius:50%;'
      + 'font:13px/16px sans-serif;text-align:center;cursor:grab;user-select:none;'
      + 'z-index:2147483647;pointer-events:auto;touch-action:none;';
    el.appendChild(rotateEl);
    syncHandleZoom(readZoom(el));
    clampHandles();
  }

  // 手柄视口钳制（§18.5 验收 bug#1 + 复测残余缺口）：外探式手柄在元素贴 iframe 边缘时被裁出文档不可点。
  // 逐级内翻迭代（2px → 20% → 45%）：元素经 zoom 放大或 rotate 旋转后，贴内侧 2px 的手柄仍可能被映射出界，
  // 迭代内翻直至回到视口（旋转 pivot=元素中心恒在画布内，45% 深度必收敛）。
  // 选中时跑一次；手势期间每次 apply 后复跑（缩放/旋转会改变手柄的视口落点）。
  function clampHandles() {
    var cw = document.documentElement.clientWidth, chh = document.documentElement.clientHeight;
    [handleEl, resetEl, rotateEl].forEach(function (h) {
      if (!h) return;
      for (var i = 0; i < 3; i++) {
        var r = h.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx <= cw - 2 && cx >= 2 && cy <= chh - 2 && cy >= 2) break;
        var inset = i === 0 ? '2px' : i === 1 ? '20%' : '45%';
        if (cx > cw - 2) { h.style.right = inset; h.style.left = 'auto'; }
        if (cx < 2) { h.style.left = inset; h.style.right = 'auto'; }
        if (cy > chh - 2) { h.style.bottom = inset; h.style.top = 'auto'; }
        if (cy < 2) { h.style.top = inset; h.style.bottom = 'auto'; }
      }
      // 兜底：旋转把宽元素的横向偏移耦合成纵向出界（30° 时 ↺ 的 left:-10px 把 cy 带出顶缘，单轴翻修不够）——
      // 钉到元素中心（旋转 pivot 恒映射自身，元素中心受移动钳制恒在画布内=恒在视口内），三柄微错开防堆叠
      var r2 = h.getBoundingClientRect();
      var cx2 = r2.left + r2.width / 2, cy2 = r2.top + r2.height / 2;
      if (cx2 > cw - 2 || cx2 < 2 || cy2 > chh - 2 || cy2 < 2) {
        h.style.left = '50%'; h.style.right = 'auto';
        h.style.top = '50%'; h.style.bottom = 'auto';
        h.style.transform = 'translate(-50%,-50%) ' + (h === handleEl ? 'translateX(-16px)' : h === resetEl ? 'translateX(16px)' : 'translateY(16px)');
      } else {
        h.style.transform = '';
      }
    });
  }

  // 退出编辑态：移除手柄/按钮/浮层，还原行内样式
  function deselect() {
    if (handleEl && handleEl.parentNode) handleEl.parentNode.removeChild(handleEl);
    if (resetEl && resetEl.parentNode) resetEl.parentNode.removeChild(resetEl);
    if (rotateEl && rotateEl.parentNode) rotateEl.parentNode.removeChild(rotateEl);
    handleEl = null;
    resetEl = null;
    rotateEl = null;
    if (selected && savedStyle) {
      selected.style.outline = savedStyle.outline;
      selected.style.outlineOffset = savedStyle.outlineOffset;
      selected.style.touchAction = savedStyle.touchAction;
    }
    selected = null;
    savedStyle = null;
    hideTip();
  }

  // ---------- 提交 ----------

  // 拖拽/缩放/旋转/复位结束时回传父页面；复位 layout 传 null；数值保留 1 位小数。
  // 新语义 payload = {x,y,scale,rotate}：x,y = 元素可视中心占画布百分比；rotate 恒带（为 0 时上报 0）
  function commit(el, layout) {
    var pointId = el.getAttribute('data-point-id') || '';
    var payload = layout
      ? { x: round1(layout.x), y: round1(layout.y), scale: round1(layout.scale), rotate: round1(layout.rotate || 0) }
      : null;
    try {
      var p = window.parent;
      if (p && typeof p.__packagingEditCommit === 'function') {
        p.__packagingEditCommit(pointId, payload, payload);
      }
    } catch (err) { /* 父页面未注册或跨域时静默忽略 */ }
  }

  // ---------- 手势 ----------

  // 拖拽移动：pointerdown 量起始中心 C0（画布%）与指针起点，z/deg 记入手势内变量（手势期间不 re-read）。
  // move 时目标中心 = C0 + 指针屏幕位移/rootRect×100（% 归一化，外层预览缩放自动约掉），
  // 按元素外接框半宽/半高% 钳在画布内后委托 apply——桥完全不碰 style 偏移
  function startMove(el, e) {
    if (!hasApply()) return; // 契约缺失：静默不拖（保留选中高亮）
    var rootRect = canvasRect();
    var c0 = centerPct(el, rootRect);
    session = {
      kind: 'move', el: el, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      c0: c0,
      rootRect: rootRect,
      target: { x: c0.x, y: c0.y, scale: readZoom(el), rotate: readRotate(el) },
      moved: false
    };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // 角点缩放：倍率 = 指针到元素可视中心的当前距离 / 起始距离，z' 钳到 0.3~3 后委托 apply。
  // apply 自带中心锚定（目标中心固定为手势起点中心 C0），旧版反向修正逻辑由模板端闭环取代
  function startScale(el, e) {
    if (!hasApply()) return;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var c0 = centerPct(el, canvasRect());
    session = {
      kind: 'scale', el: el, pointerId: e.pointerId,
      cx: cx, cy: cy,
      startDist: Math.max(1, Math.sqrt(Math.pow(e.clientX - cx, 2) + Math.pow(e.clientY - cy, 2))),
      z0: readZoom(el),
      target: { x: c0.x, y: c0.y, scale: readZoom(el), rotate: readRotate(el) },
      moved: false
    };
    try { handleEl.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // 旋转手柄：以元素可视中心为圆心，按指针极角增量累加到起始角度，规范化到 -180~180 后委托 apply。
  // apply 自带中心锚定（目标中心固定为 C0），绕版式中心「公转」问题由模板端闭环吸收
  function startRotate(el, e) {
    if (!hasApply()) return;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var c0 = centerPct(el, canvasRect());
    var r0 = readRotate(el);
    session = {
      kind: 'rotate', el: el, pointerId: e.pointerId,
      cx: cx, cy: cy,
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx),
      r0: r0,
      target: { x: c0.x, y: c0.y, scale: readZoom(el), rotate: r0 },
      moved: false
    };
    try { rotateEl.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onPointerMove(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    var el = session.el;
    var t = session.target; // 手势内目标状态：move 改中心、scale 改倍率、rotate 改角度，其余分量保持
    if (session.kind === 'move') {
      // 指针屏幕位移 → 画布% 位移，叠加到起始中心
      var tx = session.c0.x + (e.clientX - session.startClientX) / session.rootRect.width * 100;
      var ty = session.c0.y + (e.clientY - session.startClientY) / session.rootRect.height * 100;
      // 中心可达范围：元素当前外接框（含 zoom/rotate）半宽/半高% 为界，允许 EDGE_TOL px 误差
      var r = el.getBoundingClientRect();
      var hw = r.width / session.rootRect.width * 50;
      var hh = r.height / session.rootRect.height * 50;
      var tolX = EDGE_TOL / session.rootRect.width * 100;
      var tolY = EDGE_TOL / session.rootRect.height * 100;
      t.x = clampNum(tx, hw - tolX, 100 - hw + tolX);
      t.y = clampNum(ty, hh - tolY, 100 - hh + tolY);
    } else if (session.kind === 'scale') {
      var dist = Math.max(1, Math.sqrt(Math.pow(e.clientX - session.cx, 2) + Math.pow(e.clientY - session.cy, 2)));
      t.scale = clampNum(session.z0 * dist / session.startDist, MIN_SCALE, MAX_SCALE);
      syncHandleZoom(t.scale);
    } else { // rotate
      var ang = Math.atan2(e.clientY - session.cy, e.clientX - session.cx);
      t.rotate = normDeg(session.r0 + (ang - session.startAngle) * 180 / Math.PI);
    }
    scheduleApply(el, t); // rAF 节流应用（每帧最多一次，取最新目标）
    showTip(el, t);       // 浮层数值与目标状态同源，严格跟手
    session.moved = true;
  }

  // 手势结束统一提交：先落地 rAF 挂起的最后一帧目标，再量最终可视状态回传父页面
  function onPointerUp(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    var el = session.el;
    var moved = session.moved;
    session = null;
    flushPending();
    hideTip();
    if (moved) {
      swallowClick = true;
      commit(el, readLayout(el));
    }
  }

  // 单条复位：模板恢复默认版式（含旋转，由模板端 __pointLayout.apply 契约保证），并通知父页面清除该条布局
  function doReset() {
    if (!selected) return;
    var el = selected;
    try {
      if (window.__pointLayout && typeof window.__pointLayout.apply === 'function') {
        window.__pointLayout.apply(el, null);
      }
    } catch (err) {}
    syncHandleZoom(readZoom(el)); // apply(null) 可能改了 zoom，同步手柄补偿
    clampHandles(); // 复位后几何还原，手柄按新落点复钳
    hideTip();
    swallowClick = true;
    commit(el, null);
  }

  // 滚轮缩放（选中态）：指针悬停在选中元素上时接管滚轮，每格 ±8% 步进、中心锚定（委托 apply）。
  // z/deg/中心在滚轮手势状态里跟踪（首次滚动以当前可视状态为基准建立，期间不 re-read）；
  // 120ms 节流应用（节流后频率足够低，同步调 apply 即可），连续滚动停歇 300ms 后提交一次
  function onWheel(e) {
    var m = activeMode();
    if (!m || !selected || !hasApply()) return;
    var over = hitFromPoint(e.clientX, e.clientY, m) === selected
      || (e.target && typeof selected.contains === 'function' && selected.contains(e.target));
    if (!over) return;
    e.preventDefault();
    e.stopPropagation();
    var now = Date.now();
    if (now - lastWheelApply >= WHEEL_THROTTLE) {
      lastWheelApply = now;
      if (!wheelSession || wheelSession.el !== selected) {
        var c = centerPct(selected, canvasRect());
        wheelSession = { el: selected, x: c.x, y: c.y, z: readZoom(selected), deg: readRotate(selected) };
      }
      wheelSession.z = clampNum(wheelSession.z * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), MIN_SCALE, MAX_SCALE);
      applyLayout(selected, { x: wheelSession.x, y: wheelSession.y, scale: wheelSession.z, rotate: wheelSession.deg });
      syncHandleZoom(wheelSession.z);
      clampHandles();
      showTip(selected, { x: wheelSession.x, y: wheelSession.y, scale: wheelSession.z, rotate: wheelSession.deg });
    }
    if (wheelTimer) clearTimeout(wheelTimer);
    var el = selected;
    wheelTimer = setTimeout(function () {
      wheelTimer = 0;
      wheelSession = null;
      hideTip();
      // 停歇时选中态可能已切换；元素仍在文档内就把当前可视状态如实上报一次
      if (el.isConnected) commit(el, readLayout(el));
    }, WHEEL_COMMIT);
  }

  // 命中堆叠解析：模板常有透明装饰层（如手势/边框/封面 .stage）盖在卖点上方，
  // e.target 会被透明层截获——用 elementsFromPoint 取命中链里第一个可编辑元素
  function hitFromPoint(x, y, m) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var el = hitEditable(stack[i], m);
      if (el) return el;
    }
    return null;
  }

  // ---------- 事件入口 ----------

  function onPointerDown(e) {
    flushPending(); // 防御：上一手势的 rAF 目标若还没落地（新指针事件抢在帧回调前到达），先落地再量取
    var m = activeMode();
    if (!m) return; // 编辑模式未激活：完全放行，不干扰模板自身动画/交互
    // 父页面包装文字浮框可能开着：pointerdown 的 preventDefault 会阻断 iframe 取焦（父页 input 不触发 blur），
    // 显式 blur 让浮框按「失焦提交」语义落地（§B 画面内文字直改）
    try { var ae = window.parent && window.parent.document && window.parent.document.activeElement; if (ae && typeof ae.blur === 'function' && ae !== window.parent.document.body) ae.blur(); } catch (err) {}
    // 手柄命中走命中栈（与气泡同款 elementsFromPoint 穿透）：正片气泡上方常盖透明层（.stage 等），
    // e.target 精确匹配会被透明层截获、手柄分支全部落空——封面卖点在 .stage 内所以正常，
    // 2026-10-09 用户实机实锤（A 项目正片挂/B 项目封面挂，合成事件直派元素测不出）
    var stack = document.elementsFromPoint(e.clientX, e.clientY);
    var handleKind = null;
    for (var si = 0; si < stack.length; si++) {
      var node = stack[si];
      if (handleEl && (node === handleEl || handleEl.contains(node))) { handleKind = 'scale'; break; }
      if (rotateEl && (node === rotateEl || rotateEl.contains(node))) { handleKind = 'rotate'; break; }
      if (resetEl && (node === resetEl || resetEl.contains(node))) { handleKind = 'reset'; break; }
    }
    if (handleKind && selected) {
      e.preventDefault();
      e.stopPropagation();
      if (handleKind === 'scale') startScale(selected, e);
      else if (handleKind === 'rotate') startRotate(selected, e);
      else doReset();
      return;
    }
    var el = hitFromPoint(e.clientX, e.clientY, m);
    if (!el) {
      // ⑤ 直点改选：only 锁定某条卖点时点到另一条气泡——上报父页面改选（与时间线点选同效），而非按点空白清空
      var reselected = false;
      if (m.only) {
        var stackX = document.elementsFromPoint(e.clientX, e.clientY);
        for (var xi = 0; xi < stackX.length; xi++) {
          var nodeX = stackX[xi];
          if (!nodeX || typeof nodeX.closest !== 'function') continue;
          var elX = nodeX.closest('[data-point-id^="cue:"]');
          if (!elX) continue;
          var pidX = elX.getAttribute('data-point-id');
          if (!pidX || pidX === m.only) continue;
          var csX = window.getComputedStyle(elX);
          var opX = parseFloat(csX.opacity);
          if (csX.display === 'none' || csX.visibility === 'hidden' || (isFinite(opX) ? opX : 1) < 0.05) continue;
          try {
            var pX = window.parent;
            if (pX && typeof pX.__packagingEditCueSelect === 'function') { pX.__packagingEditCueSelect(pidX.slice(4)); reselected = true; }
          } catch (err) {}
          break;
        }
      }
      deselect();
      if (!reselected) exitToParent(); // 真点空白才清父页面卖点选中（取消出口）；事件照常放行
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    select(el);
    startMove(el, e);
  }

  // 手势后的 click 一并吞掉，避免穿透触发模板内点击逻辑
  function onClickCapture(e) {
    var m = activeMode();
    if (!m) { swallowClick = false; return; }
    if (swallowClick || hitFromPoint(e.clientX, e.clientY, m)
      || (handleEl && (e.target === handleEl || handleEl.contains(e.target)))
      || (resetEl && (e.target === resetEl || resetEl.contains(e.target)))
      || (rotateEl && (e.target === rotateEl || rotateEl.contains(e.target)))) {
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // 通知父页面退出编辑/清卖点选中（ESC 与点空白共用——§18.5 摩擦项：卖点选中此前无取消出口）
  function exitToParent() {
    try {
      var p = window.parent;
      if (p && typeof p.__packagingEditExit === 'function') p.__packagingEditExit();
    } catch (err) {}
  }

  // ESC：通知父页面退出编辑模式，并清理本地选中态
  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    exitToParent();
    deselect();
  }

  // 父页面可随时切换/关闭编辑模式（含 only 变化）：轮询同步。
  // 无选中态且 only 指定元素 → 自动高亮（父页面跳转选中场景，如时间线点卖点块，无需再点一次）；
  // 有选中态 → 模式关闭或 only 排除当前元素时清理。
  // dataset.edit 是占位标题文字（data-placeholder）的可见性开关：active 镜像，CLI 渲染无此标记占位隐藏不进成片。
  setInterval(function () {
    var m = activeMode();
    if (m) document.documentElement.dataset.edit = '1';
    else delete document.documentElement.dataset.edit;
    if (!selected) {
      if (!m || !m.only) return;
      var target = document.querySelector('[data-point-id="' + m.only + '"]');
      if (!target) return;
      var cs = window.getComputedStyle(target);
      var op = parseFloat(cs.opacity);
      // 元素未入场（opacity 低）时下个周期再试，保证选中即完整可见
      if (cs.display === 'none' || cs.visibility === 'hidden' || (isFinite(op) ? op : 1) < 0.05) return;
      select(target);
      return;
    }
    if (!m || (m.only && selected.getAttribute('data-point-id') !== m.only)) deselect();
  }, 250);

  // 双击改文案（§B 画面内文字直改）：命中栈解析（含 data-placeholder 占位标题——与有字元素同路双击进编辑），
  // 桥不碰文本内容，只把 {pointId, 元素屏幕 rect} 上报父页面，浮框/提交全部由父页面承担
  // （浮框在父页渲染：iframe 视口会裁掉大浮层、且焦点/快捷键边界集中处理）。
  function onDblClick(e) {
    var m = activeMode();
    if (!m) return;
    var stack = document.elementsFromPoint(e.clientX, e.clientY);
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (!node || typeof node.closest !== 'function') continue;
      var el = node.closest('[data-point-id]');
      if (!el) continue;
      var pid = el.getAttribute('data-point-id');
      if (m.only && pid !== m.only) continue;
      var cs = window.getComputedStyle(el);
      var opacity = parseFloat(cs.opacity);
      if (!isFinite(opacity)) opacity = 1;
      if (cs.display === 'none' || cs.visibility === 'hidden' || opacity < 0.05) continue;
      e.preventDefault();
      e.stopPropagation();
      deselect(); // 双击进入文字编辑即放下拖拽选中态（第一次单击可能已选中）
      var r = el.getBoundingClientRect();
      try {
        var p = window.parent;
        if (p && typeof p.__packagingEditText === 'function') {
          p.__packagingEditText(pid, { left: r.left, top: r.top, width: r.width, height: r.height });
        }
      } catch (err) { /* 父页面未注册或跨域时静默忽略 */ }
      return;
    }
  }

  // 全部走捕获阶段：编辑态下优先于模板自身监听器拿到事件
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // 滚轮必须显式 passive:false，否则 Chrome 对 document 级监听默认 passive，preventDefault 无效
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });

  // 暴露句柄：幂等标记 + 供父页面主动清理选中态
  window.__packagingEditBridge = { deselect: deselect };
})();`;
