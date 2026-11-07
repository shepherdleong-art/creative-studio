// 剪辑区：操作照搬正式产品的 mixcut（PreviewStep + MixcutTimeline + TrimEditor），降低学习成本。
// 预览是实时合成：9 段分镜视频 + 字幕、卖点、封面叠加层；声音借用真实成片的音轨。
const SRC_DUR = { 1:5, 2:4, 3:4, 4:4, 5:4, 6:5, 7:5, 8:5, 9:5 };
const SHOT_NAME = { 1:'01-分镜-全景', 2:'02-分镜-侧角全景', 3:'03-分镜-扶手细节', 4:'04-分镜-坐垫下结构', 5:'05-分镜-踩踏承重', 6:'06-分镜-舒展', 7:'07-分镜-半躺', 8:'08-分镜-坐姿', 9:'09-分镜-收尾' };
const COVER_SEC = 20 / 24, FPS24 = 24;
const fmtSrc = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// ---------- 合成预览 ----------
const cpVids = {};
function cpVideo(k) { if (!cpVids[k]) { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = A[`vv${k}`]; v.className = 'btv'; v.setAttribute('muted', ''); cpVids[k] = v; } return cpVids[k]; }
function cpMount() { const slot = $('#cp-slot'); if (!slot) { Object.values(cpVids).forEach(v => { if (!v.paused) v.pause(); }); return false; } range(1, 9).forEach(k => slot.append(cpVideo(k))); return true; }
// o：{ clips, subs, points, style, cover, pk, t, playing, srcK }
function cpUpdate(o) {
  const t = o.t, c = o.srcK ? null : o.clips.find(x => !x.cover && t >= x.t0 && t < x.t1), showK = o.srcK || (c && c.k);
  range(1, 9).forEach(k => { const v = cpVids[k]; if (!v) return; const on = k === showK; v.classList.toggle('on', on); if (!on && !v.paused) v.pause(); });
  if (showK) {
    const v = cpVideo(showK), want = o.srcK ? t % SRC_DUR[o.srcK] : (c.inPt || 0) + (t - c.t0) * (c.rate || 1);
    if (Math.abs(v.currentTime - want) > .25) { try { v.currentTime = want; } catch { /* 还没就绪 */ } }
    if (o.playing && v.paused) v.play().catch(() => {}); if (!o.playing && !v.paused) v.pause();
    v.style.transform = c && (c.fz !== 1 || c.fx || c.fy) ? `translate(${c.fx * 40}%,${c.fy * 40}%) scale(${c.fz})` : '';
  }
  const cov = $('#cp-cover'); if (cov) cov.style.display = !o.srcK && t < COVER_SEC ? '' : 'none';
  const gap = $('#cp-gap'); if (gap) gap.style.display = !o.srcK && t >= COVER_SEC && !c ? '' : 'none';
  const fr = $('#cp-frame'), k = fr ? fr.offsetWidth / 1080 : .27;
  const sub = $('#cp-sub'); if (sub) { const s = o.srcK ? null : o.subs.find(x => t >= x.t0 && t < x.t1); sub.textContent = s ? s.text : ''; sub.setAttribute('style', styleCss(o.style, k)); }
  const pk = $('#cp-pk');
  if (pk) {
    const on = o.pk && o.pk.on && !o.srcK && t >= COVER_SEC, pts = on ? (o.points || []).map((p, i) => [p, i]).filter(([p]) => t >= p.t0 && t < p.t1) : [];
    pk.className = `cp-pk tm${o.pk ? o.pk.tpl + 1 : 1}`;
    const html = pts.map(([p, i]) => `<em class="cp-pt" data-pt="${i}" style="left:${(p.x * 100).toFixed(1)}%;top:${(p.y * 100).toFixed(1)}%" title="双击改字，拖动换位置">${esc(p.text)}</em>`).join('');
    if (pk.dataset.html !== html) { pk.innerHTML = html; pk.dataset.html = html; }
  }
}
function cpFrameHTML(o) {
  return `<div class="cp-frame ${o.cls || ''}" id="cp-frame"><div id="cp-slot"></div>
    <div class="cp-cover" id="cp-cover"><img src="${A[`p${o.cover.clip}`]}" alt="" style="transform:translate(${o.cover.x * 30}%,${o.cover.y * 30}%) scale(${o.cover.zoom})">${o.cover.titleOn ? `<b style="color:${o.cover.st.t1.color}">${esc(o.cover.t1)}</b><i style="color:${o.cover.st.t2.color}">${esc(o.cover.t2)}</i>` : ''}</div>
    <div class="cp-gap" id="cp-gap">空位：这里还没有画面</div><div class="cp-sub" id="cp-sub"></div><div class="cp-pk" id="cp-pk"></div>${o.safe ? '<span class="st-safe"></span>' : ''}</div>`;
}

// ---------- 单条混剪的状态 ----------
const MIX_K = [0, 1, 4, 5, 3, 6, 9];
S.mix.clips.forEach((c, i) => Object.assign(c, { k:MIX_K[i] || 1, img:i ? `p${MIX_K[i]}` : c.img, srcDur:i ? SRC_DUR[MIX_K[i]] : c.t1 }));
S.mix.points = [{ t0:3.7, t1:5.8, text:'约6.5厘米实心粗腿', x:.5, y:.66 }, { t0:6.4, t1:8.6, text:'约4.5厘米立水支撑', x:.5, y:.66 }, { t0:9.1, t1:11.1, text:'约2.6厘米厚料大板', x:.5, y:.66 }, { t0:11.3, t1:13.6, text:'约60厘米宽适座深', x:.5, y:.66 }];
S.mix.ed = { pps:0, tool:'select', snap:true, sel:{ kind:'sub', i:2 }, mat:null, hist:[], fut:[], editing:null, view:'film', srcK:null, repOpen:true, rightOpen:true };
const edSnapshot = () => ({ clips:clone(S.mix.clips), subs:clone(S.mix.subs), points:clone(S.mix.points) });
function edPush() { const e = S.mix.ed; e.hist.push(edSnapshot()); e.fut = []; }
function edRestore(s) { S.mix.clips = s.clips; S.mix.subs = s.subs; S.mix.points = s.points; }
const edSelClip = () => { const e = S.mix.ed, c = e.sel && e.sel.kind === 'clip' ? S.mix.clips[e.sel.i] : null; return c && !c.cover ? c : null; };
function edGaps() {
  const list = S.mix.clips.filter(c => !c.cover).sort((a, b) => a.t0 - b.t0), gaps = []; let t = COVER_SEC;
  list.forEach(c => { if (c.t0 - t >= .5) gaps.push({ t0:t, t1:c.t0 }); t = Math.max(t, c.t1); });
  if (FILM.dur - t >= .5) gaps.push({ t0:t, t1:FILM.dur });
  return gaps;
}
function edState() { const m = S.mix, e = m.ed; return { clips:m.clips, subs:m.subs, points:m.points, style:m.st, cover:m.cover, pk:m.pk, t:m.t, playing:m.playing, srcK:e.view === 'src' ? e.srcK : null }; }
function edLive() {
  if (S.screen !== 'mix' || S.mix.step !== 2) return;
  const m = S.mix; cpUpdate(edState());
  const h = $('#ed-head'); if (h) h.style.transform = `translateX(${m.t * m.ed.pps}px)`;
  $$('[data-ed-time]').forEach(el => { el.textContent = fmtT(m.t); });
}
(function edTick() { if (S.screen === 'mix' && S.mix.step === 2) edLive(); requestAnimationFrame(edTick); })();
function edSeek(t) { const m = S.mix, v = film(); m.t = Math.max(0, Math.min(FILM.dur - .01, t)); try { v.currentTime = m.t; } catch { /* 还没就绪 */ } edLive(); }

// ---------- 左栏：素材调整 ----------
function edReplaceCol() {
  const m = S.mix, e = m.ed, sel = edSelClip(), gap = edGaps()[0], used = new Set(m.clips.map(c => c.k));
  const hint = sel && gap ? `当前片段已选中，时间轴另有 ${(gap.t1 - gap.t0).toFixed(2)}s 缺口。先选素材，再明确选择替换或添加。`
    : sel ? '当前片段已选中。先选素材，再点击「替换当前片段」；裁剪或删除可腾出添加缺口。'
    : gap ? `时间轴有 ${(gap.t1 - gap.t0).toFixed(2)}s 缺口。先选素材，再点击「添加到缺口」。`
    : '单击下方素材会高亮选中，点击「预览」查看视频；选中时间轴片段后可替换，右键片段可删除并腾出缺口。';
  if (!e.repOpen) return `<aside class="ed-rail"><button data-act="edCol" data-v="repOpen" title="展开素材替换">›</button></aside>`;
  return `<aside class="ed-rep"><h4>${ic('retry')}<span>素材调整</span><button class="ed-colbtn" data-act="edCol" data-v="repOpen" title="隐藏素材替换">‹</button></h4>
    <p class="ed-hint">${hint}</p>
    <div class="ed-selbar"><span>${e.mat ? `已选：${SHOT_NAME[e.mat]}` : '尚未选择素材'}</span><div class="rc-btns"><button class="btn sm" data-act="edReplace" ${e.mat && sel ? '' : 'disabled'} title="${!sel ? '先在时间轴单击选中要替换的片段' : !e.mat ? '先在下方选择素材' : ''}">替换当前片段</button><button class="btn sm pri" data-act="edInsert" ${e.mat && gap ? '' : 'disabled'} title="${!gap ? '时间轴当前没有可插入的缺口' : !e.mat ? '先在下方选择素材' : ''}">${ic('plus')}添加到缺口</button></div></div>
    <div class="ed-list" data-keep-scroll="edl">${range(1, 9).map(k => `<div class="ed-it ${e.mat === k ? 'on' : ''}"><button class="ed-pick" data-act="edMat" data-v="${k}" title="选择素材「${SHOT_NAME[k]}」"><img src="${A[`p${k}`]}" alt="${SHOT_NAME[k]}"><span><b>${SHOT_NAME[k]}</b><small>${SRC_DUR[k].toFixed(1)}s，视频生成，已分析</small></span>${e.mat === k ? `<span class="tag run">${ic('check')}已选</span>` : used.has(k) ? '<span class="tag ok">已用</span>' : ''}</button>
      <div class="ed-it-a"><button class="link" data-act="edPrevMat" data-v="${k}">预览</button><button class="link" data-act="toastMsg" data-v="正在重新分析素材…素材分析完成，可以添加或替换片段（示例）">重新分析</button></div></div>`).join('')}</div></aside>`;
}

// ---------- 中间：预览 + 截取 + 时间轴 ----------
function edTrimHTML(c, idx, inPt, compact) {
  const src = c.srcDur || SRC_DUR[c.k], len = (c.t1 - c.t0) * (c.rate || 1), off = inPt / src * 100, win = Math.min(100, len / src * 100);
  return `<div class="trim-ed ${compact ? 'compact' : ''}"><div class="trim-h"><span class="trim-t">${ic('scissors')}${compact ? `截取 #${idx}` : `截取片段 #${idx}，源素材 ${fmtSrc(src)}`}</span>${compact ? '' : '<span class="trim-hint">拖动选框选取画面，片段时长保持不变</span>'}<span class="trim-d" id="trim-d">入点 ${fmtSrc(inPt)} → 出点 ${fmtSrc(inPt + len)}</span><span class="sp"></span><button class="btn sm" data-act="trimCancel">取消</button><button class="btn sm pri" data-act="trimDone">完成</button></div>
    <div class="trim-strip" data-trim-strip title="拖动选框选取画面，片段时长保持不变">${range(0, 15).map(i => `<i style="background-image:url(${A[`p${c.k}`]});filter:brightness(${i % 2 ? .82 : 1})"></i>`).join('')}<b class="trim-dim" style="left:0;width:${off}%"></b><b class="trim-dim" style="left:${off + win}%;right:0"></b><b class="trim-win" style="left:${off}%;width:${win}%"></b></div></div>`;
}
function edWave(w, h, alpha) { let d = ''; const n = Math.max(1, Math.floor(w / 4.5)); for (let i = 0; i < n; i++) { const a = WAVE[Math.floor(i / n * WAVE.length)] * alpha * (h / 2 - 1); d += `M${(i * 4.5).toFixed(1)} ${(h / 2 - a).toFixed(1)}V${(h / 2 + a).toFixed(1)}`; } return `<svg class="ed-wave" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}"/></svg>`; }
function edTimeline() {
  const m = S.mix, e = m.ed, pps = e.pps || 60, W = FILM.dur * pps, sel = e.sel || {};
  const pos = (a, b) => `left:${(a * pps).toFixed(1)}px;width:${Math.max(4, (b - a) * pps - 2).toFixed(1)}px`;
  const handles = '<i class="h l" data-h="l"></i><i class="h r" data-h="r"></i>';
  const edIn = (kind, i, text) => e.editing && e.editing.kind === kind && e.editing.i === i ? `<input class="ed-in" data-ed-in="${kind}:${i}" value="${esc(text)}">` : `<span>${esc(text)}</span>`;
  let ticks = ''; const every = pps < 50 ? 2 : 1; for (let s = 0; s <= FILM.dur; s++) ticks += `<i class="${s % every ? 'mi' : ''}" style="left:${s * pps}px">${s % every ? '' : `${s}s`}</i>`;
  const subs = m.subs.map((s, i) => `<div class="ed-cue ${sel.kind === 'sub' && sel.i === i ? 'sel' : ''}" data-ed="sub" data-i="${i}" style="${pos(s.t0, s.t1)}" title="${e.tool === 'split' ? '点击此处切开字幕' : '拖动字幕块移动，拖两侧修剪，双击改字，右键删除'}">${edIn('sub', i, s.text)}${handles}</div>`).join('');
  const pts = m.points.map((p, i) => `<div class="ed-cue pt ${sel.kind === 'pt' && sel.i === i ? 'sel' : ''}" data-ed="pt" data-i="${i}" style="${pos(p.t0, p.t1)}" title="单击选中，拖动改弹出时间，拖两侧修剪，双击改字，右键删除">${edIn('pt', i, p.text)}${handles}</div>`).join('');
  const clips = m.clips.map((c, i) => c.cover ? `<div class="ed-clip cover" data-ed="cover" data-i="${i}" style="${pos(c.t0, c.t1)};background-image:url(${A[c.img]})"><span>封面</span></div>`
    : `<div class="ed-clip ${sel.kind === 'clip' && sel.i === i ? 'sel' : ''} ${e.mat === c.k ? 'mat' : ''}" data-ed="clip" data-i="${i}" style="${pos(c.t0, c.t1)};background-image:url(${A[`p${c.k}`]})" title="${e.tool === 'split' ? '点击切开视频，两侧均需至少保留 0.5 秒' : '单击选中，拖拽排序，双击截取时段，右键更多操作'}"><span>${((c.t1 - c.t0)).toFixed(1)}s${c.rate !== 1 ? ` ${c.rate.toFixed(2)}×` : ''}</span>${handles}</div>`).join('');
  const narW = (FILM.dur - COVER_SEC) * pps - 2, bgmW = W - 2;
  return `<div class="ed-tl" data-ed-scope="mix"><div class="tl-tools" role="toolbar" aria-label="时间轴工具">
      <button class="btn ${e.tool === 'select' ? 'on' : ''}" data-act="edTool" data-v="select" title="选择工具 (V)">选择</button><button class="btn ${e.tool === 'split' ? 'on' : ''}" data-act="edTool" data-v="split" title="分割工具 (B)">${ic('scissors')}分割</button>
      <button class="btn" data-act="edAddPoint" title="在播放头处新增卖点标签（默认取当前字幕句，封面段内自动钳到片头结束点）">${ic('plus')}卖点</button>
      <button class="btn" data-act="edUndo" ${e.hist.length ? '' : 'disabled'} title="撤销 (⌘/Ctrl+Z)">撤销</button><button class="btn" data-act="edRedo" ${e.fut.length ? '' : 'disabled'} title="重做 (⌘/Ctrl+Shift+Z)">重做</button>
      <button class="btn ${e.snap ? 'on' : ''}" data-act="edSnap" title="视频磁吸 (N)，Alt 临时关闭">磁吸${e.snap ? '开' : '关'}</button>
      <span class="r"><label class="ed-zoom"><span>缩放</span><input type="range" min="40" max="240" step="10" data-ed-zoom value="${pps}" aria-label="时间轴缩放"></label><button class="btn" data-act="edHelp" title="快捷键说明">?</button></span></div>
    <div class="ed-tlb"><div class="ed-labels"><span class="g"></span><span>字幕</span><span class="pt">卖点</span><span class="v">视频</span><span class="a">口播</span><span class="a">配乐</span></div>
      <div class="ed-scroll" data-keep-scroll-x="eds"><div class="ed-canvas" data-ed-canvas style="width:${W + 40}px">
        <div class="ed-ruler" data-ed="ruler">${ticks}</div>
        <div class="ed-row">${subs}</div><div class="ed-row pt">${pts || '<span class="ed-empty">点「＋卖点」添加</span>'}</div><div class="ed-row v">${clips}</div>
        <div class="ed-row a"><div class="ed-aud nar ${sel.kind === 'nar' ? 'sel' : ''}" data-ed="nar" style="left:${(COVER_SEC * pps).toFixed(1)}px;width:${narW.toFixed(1)}px" title="右键调整口播音频倍速">${edWave(Math.max(10, Math.floor(narW)), 30, 1)}<span>口播，${S.mix.voice != null ? VOICES[S.mix.voice][0] : 'TTS'}，${m.nar.rate.toFixed(1)}x</span></div></div>
        <div class="ed-row a">${m.bgm.track ? `<div class="ed-aud bgm ${sel.kind === 'bgm' ? 'sel' : ''}" data-ed="bgm" style="left:0;width:${bgmW.toFixed(1)}px" title="分割工具点击裁切，右键删除音频片段">${edWave(Math.max(10, Math.floor(bgmW)), 22, .45)}<span>♫ ${esc(m.bgm.track)}</span></div>` : '<span class="ed-empty">无 BGM</span>'}</div>
        <div class="ed-head" id="ed-head" data-ed="head" style="transform:translateX(${m.t * pps}px)"><b></b></div>
      </div></div></div></div>`;
}
function mixEditor() {
  const m = S.mix, e = m.ed, c = edSelClip(), ci = c ? m.clips.indexOf(c) : -1, src = e.view === 'src';
  const trim = S.trim && S.trim.scope === 'mix' ? edTrimHTML(m.clips[S.trim.i], S.trim.i, S.trim.inPt, false) : '';
  const cols = `${e.repOpen ? '236px' : '22px'} minmax(0,1fr) ${e.rightOpen ? '300px' : '22px'}`;
  return `<div class="ed" style="grid-template-columns:${cols}">${edReplaceCol()}
    <main class="ed-main" data-keep-scroll="edm"><div class="mon-h"><div class="seg sm"><button class="${src ? '' : 'on'}" data-act="edView" data-v="film">成片预览</button><button class="${src ? 'on' : ''}" data-act="edView" data-v="src">素材预览</button></div><span class="r">${src ? (e.srcK ? `素材预览：${SHOT_NAME[e.srcK]}` : '请从左侧素材列表点击「预览」') : '实时合成预览，24 fps'}</span></div>
      <div class="stage">${cpFrameHTML({ cover:m.cover, safe:m.safe, cls:m.ratio === '9:16' ? 'r916' : '' })}<div id="film-slot" class="ed-audio" aria-hidden="true"></div></div>
      <div class="transport"><button class="play" data-act="mixPlay" title="空格">${ic(m.playing ? 'pause' : 'play')}</button><span><span data-ed-time>${fmtT(m.t)}</span> <small>/ ${fmtT(FILM.dur)}</small></span><span class="r"><div class="seg sm" style="height:26px"><button class="${m.ratio === '3:4' ? 'on' : ''}" data-act="mixRatio" data-v="3:4">3:4</button><button class="${m.ratio === '9:16' ? 'on' : ''}" data-act="mixRatio" data-v="9:16">9:16</button></div><button class="btn ${m.safe ? 'pri' : ''}" style="height:26px" data-act="mixSafe">安全区</button></span></div>
      ${trim}${edTimeline()}</main>
    ${e.rightOpen ? `<aside class="ins ed-right" data-keep-scroll="edr"><button class="ed-colbtn r" data-act="edCol" data-v="rightOpen" title="隐藏面板">›</button>
      ${c ? card('film', '视频倍速', `<div class="fg">${rng('倍速', `mix.clips.${ci}.rate`, .25, 4, .05, 'x')}</div><p class="note">拖动调节，松手保存；后续片段位置不变。</p><button class="btn sm" data-act="setv" data-k="mix.clips.${ci}.rate" data-v="1">恢复原速（1×）</button>`) + card('image', '视频画面调整', `<div class="fg">${rng('画面缩放', `mix.clips.${ci}.fz`, .25, 3, .05, 'x')}${rng('水平位移', `mix.clips.${ci}.fx`, -1, 1, .02, 'f2')}${rng('垂直位移', `mix.clips.${ci}.fy`, -1, 1, .02, 'f2')}</div><button class="btn sm" data-act="clipFrameReset" data-k="mix.clips.${ci}">重置画面</button>`) : ''}
      ${packCard('mix')}${styleCard('mix.st')}${bgmCard('mix.bgm')}${narCards('mix.nar')}${coverEntry('mix', m.cover, m.clips.length - 1)}</aside>` : `<aside class="ed-rail r"><button data-act="edCol" data-v="rightOpen" title="展开面板">‹</button></aside>`}
  </div>`;
}

// ---------- 时间轴的拖动、修剪、排序（照 MixcutTimeline） ----------
const MIN_LEN = { clip:.5, sub:.3, pt:1.2 };
function edList(kind) { const m = S.mix; return kind === 'clip' ? m.clips : kind === 'sub' ? m.subs : m.points; }
function edNeighbors(kind, i) {
  const list = edList(kind), it = list[i], others = list.filter((x, j) => j !== i);
  const prev = Math.max(kind === 'clip' ? COVER_SEC : kind === 'pt' ? COVER_SEC : 0, ...others.filter(x => x.t0 < it.t0).map(x => x.t1));
  const next = Math.min(FILM.dur, ...others.filter(x => x.t0 >= it.t1 - .001).map(x => x.t0));
  return [prev, next];
}
function edSnapT(t, kind, i) {
  if (!S.mix.ed.snap || window.__altDown) return t;
  const tol = 7 / S.mix.ed.pps, cands = [S.mix.t, ...edList(kind).filter((x, j) => j !== i).flatMap(x => [x.t0, x.t1])];
  for (const c of cands) if (Math.abs(c - t) < tol) return c;
  return t;
}
function edRipple() { // 排序后按顺序重新排紧
  const m = S.mix, list = m.clips.filter(c => !c.cover); let t = COVER_SEC;
  list.forEach(c => { const len = c.t1 - c.t0; c.t0 = t; c.t1 = t + len; t += len; });
  m.clips = [m.clips.find(c => c.cover), ...list];
}
document.addEventListener('keydown', e => { if (e.key === 'Alt') window.__altDown = true; });
document.addEventListener('keyup', e => { if (e.key === 'Alt') window.__altDown = false; });
document.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const scope = e.target.closest && e.target.closest('[data-ed-scope="mix"]'); if (!scope) return;
  const el = e.target.closest('[data-ed]'); if (!el) return;
  const m = S.mix, ed = m.ed, kind = el.dataset.ed, i = +el.dataset.i, h = e.target.dataset.h || '', canvas = scope.querySelector('[data-ed-canvas]');
  const xToT = x => (x - canvas.getBoundingClientRect().left) / ed.pps;
  if (kind === 'ruler' || kind === 'head') {
    e.preventDefault(); const was = m.playing; if (was) acts.mixPlay(); edSeek(xToT(e.clientX));
    const move = ev => edSeek(xToT(ev.clientX)), up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); return;
  }
  if (kind === 'cover' || kind === 'nar' || kind === 'bgm') { ed.sel = { kind, i }; render(); return; }
  if (e.target.closest('.ed-in')) return;
  const list = edList(kind), it = list[i]; if (!it) return;
  if (ed.tool === 'split') { edSplit(kind, i, xToT(e.clientX)); return; }
  e.preventDefault();
  const startX = e.clientX, o = { t0:it.t0, t1:it.t1, inPt:it.inPt || 0 }, [lo, hi] = edNeighbors(kind, i), min = MIN_LEN[kind];
  let moved = false;
  const move = ev => {
    const dx = ev.clientX - startX; if (!moved && Math.abs(dx) < 3) return;
    if (!moved) { moved = true; edPush(); el.classList.add('drag'); }
    const dt = dx / ed.pps;
    if (h === 'l') {
      const floor = kind === 'clip' ? Math.max(lo, o.t0 - o.inPt / (it.rate || 1)) : lo;
      it.t0 = Math.max(floor, Math.min(o.t1 - min, edSnapT(o.t0 + dt, kind, i)));
      if (kind === 'clip') it.inPt = o.inPt + (it.t0 - o.t0) * (it.rate || 1);
    } else if (h === 'r') {
      const ceil = kind === 'clip' ? Math.min(hi, o.t0 + ((it.srcDur || SRC_DUR[it.k]) - o.inPt) / (it.rate || 1)) : hi;
      it.t1 = Math.min(ceil, Math.max(o.t0 + min, edSnapT(o.t1 + dt, kind, i)));
    } else if (kind === 'clip') { el.style.transform = `translateX(${dx}px)`; el.style.zIndex = 5; return; }
    else { const len = o.t1 - o.t0; let t0 = edSnapT(o.t0 + dt, kind, i); t0 = Math.max(lo, Math.min(hi - len, t0)); it.t0 = t0; it.t1 = t0 + len; }
    el.style.left = `${(it.t0 * ed.pps).toFixed(1)}px`; el.style.width = `${Math.max(4, (it.t1 - it.t0) * ed.pps - 2).toFixed(1)}px`;
  };
  const up = ev => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    if (!moved) { // 单击：先原地改选中，稍后重绘；紧接着第二下就当双击
      ed.sel = { kind, i }; $$('.ed-clip.sel,.ed-cue.sel,.ed-aud.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
      if ((kind === 'sub' || kind === 'pt') && !m.playing) edSeek(it.t0 + .02);
      clearTimeout(edClickT); edClickT = setTimeout(render, 280); return;
    }
    if (kind === 'clip' && !h) { // 拖拽排序
      const center = (o.t0 + o.t1) / 2 + (ev.clientX - startX) / ed.pps, body = m.clips.filter(c => !c.cover && c !== it);
      let idx = body.findIndex(c => center < (c.t0 + c.t1) / 2); if (idx < 0) idx = body.length; body.splice(idx, 0, it);
      m.clips = [m.clips.find(c => c.cover), ...body]; edRipple(); ed.sel = { kind:'clip', i:m.clips.indexOf(it) };
      toast('已调整片段顺序');
    }
    render();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
let edClickT = null;
document.addEventListener('dblclick', e => {
  const scope = e.target.closest && e.target.closest('[data-ed-scope="mix"]'); if (!scope) return;
  clearTimeout(edClickT);
  const el = e.target.closest('[data-ed]'); if (!el || S.mix.ed.tool !== 'select') return;
  const kind = el.dataset.ed, i = +el.dataset.i;
  if (kind === 'clip') { const c = S.mix.clips[i]; S.trim = { scope:'mix', i, inPt:c.inPt || 0 }; S.mix.ed.sel = { kind, i }; render(); }
  if (kind === 'sub' || kind === 'pt') { S.mix.ed.sel = { kind, i }; S.mix.ed.editing = { kind, i }; render(); const inp = $(`[data-ed-in="${kind}:${i}"]`); if (inp) { inp.focus(); inp.select(); } }
});
document.addEventListener('contextmenu', e => {
  const scope = e.target.closest && e.target.closest('[data-ed-scope="mix"]'); if (!scope) return;
  const el = e.target.closest('[data-ed]'); if (!el) return;
  const kind = el.dataset.ed; if (!['clip','sub','pt','nar','bgm'].includes(kind)) return;
  e.preventDefault(); const i = +el.dataset.i; S.mix.ed.sel = { kind, i }; render();
  S.pop = { kind:'edmenu', what:kind, i, rect:{ left:e.clientX, right:e.clientX, top:e.clientY, bottom:e.clientY, width:0, height:0 }, alignRight:false }; renderPop();
});
// 截取条：拖动选框
document.addEventListener('pointerdown', e => {
  const strip = e.target.closest && e.target.closest('[data-trim-strip]'); if (!strip || !S.trim) return;
  e.preventDefault();
  const tr = S.trim, c = tr.scope === 'mix' ? S.mix.clips[tr.i] : btFilm().clips[tr.i], src = c.srcDur || SRC_DUR[c.k], len = (c.t1 - c.t0) * (c.rate || 1), maxIn = Math.max(0, src - len), r = strip.getBoundingClientRect();
  const onWin = e.target.classList.contains('trim-win'), startX = e.clientX, base = onWin ? tr.inPt : Math.max(0, Math.min(maxIn, (startX - r.left) / r.width * src - len / 2));
  const apply = v => { tr.inPt = Math.round(Math.max(0, Math.min(maxIn, v)) * FPS24) / FPS24; const off = tr.inPt / src * 100, win = Math.min(100, len / src * 100), [d1, d2] = strip.querySelectorAll('.trim-dim'); strip.querySelector('.trim-win').style.left = `${off}%`; d1.style.width = `${off}%`; d2.style.left = `${off + win}%`; const d = $('#trim-d'); if (d) d.textContent = `入点 ${fmtSrc(tr.inPt)} → 出点 ${fmtSrc(tr.inPt + len)}`; trimPreview(); };
  apply(base);
  const move = ev => apply(base + (ev.clientX - startX) / r.width * src), up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
function trimPreview() { // 预览跳到这个片段开头，画面显示新的入点
  const tr = S.trim; if (!tr) return;
  if (tr.scope === 'mix') { const c = S.mix.clips[tr.i], keep = c.inPt; c.inPt = tr.inPt; edSeek(c.t0 + .02); c.inPt = keep; cpUpdate({ ...edState(), clips:S.mix.clips.map((x, j) => j === tr.i ? { ...x, inPt:tr.inPt } : x) }); }
  else { const f = btFilm(), c = f.clips[tr.i]; S.bt.t = c.t0 + .02; S.bt.trimIn = tr.inPt; btLive(); }
}

function edSplit(kind, i, t) {
  const list = edList(kind), it = list[i];
  if (kind === 'clip') {
    if (t - it.t0 < .5 || it.t1 - t < .5) return toast('分割后两侧视频均需至少保留 0.5 秒，请换一个分割点');
    edPush(); list.splice(i, 1, { ...it, t1:t }, { ...it, t0:t, inPt:(it.inPt || 0) + (t - it.t0) * (it.rate || 1) });
  } else {
    if (t - it.t0 < .2 || it.t1 - t < .2) return toast('离边缘太近，换一个分割点');
    edPush(); const cut = Math.max(1, Math.min(it.text.length - 1, Math.round(it.text.length * (t - it.t0) / (it.t1 - it.t0))));
    list.splice(i, 1, { ...it, t1:t, text:it.text.slice(0, cut) }, { ...it, t0:t, text:it.text.slice(cut) });
  }
  S.mix.ed.sel = { kind, i:i + 1 }; render();
}
function edDelete() {
  const ed = S.mix.ed, s = ed.sel; if (!s) return;
  if (s.kind === 'clip') { const c = S.mix.clips[s.i]; if (!c || c.cover) return; edPush(); S.mix.clips.splice(s.i, 1); toast('已删除片段，保留空位'); }
  else if (s.kind === 'sub') { edPush(); S.mix.subs.splice(s.i, 1); toast('已删除字幕'); }
  else if (s.kind === 'pt') { edPush(); S.mix.points.splice(s.i, 1); toast('已删除卖点'); }
  else if (s.kind === 'bgm') { S.mix.bgm.track = ''; toast('已删除音频片段，保留空位'); }
  else return;
  ed.sel = null; S.pop = null; render();
}
function edKey(e) {
  if (S.screen !== 'mix' || S.mix.step !== 2 || S.coverEdit) return false;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey, ed = S.mix.ed;
  if (S.trim && S.trim.scope === 'mix') { if (k === 'escape') { acts.trimCancel(); return true; } if (k === 'enter') { acts.trimDone(); return true; } }
  if (k === ' ') { e.preventDefault(); acts.mixPlay(); return true; }
  if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? acts.edRedo : acts.edUndo)(); return true; }
  if (mod && k === 'b') { e.preventDefault(); const s = ed.sel; if (s && (s.kind === 'clip' || s.kind === 'sub' || s.kind === 'pt')) edSplit(s.kind, s.i, S.mix.t); return true; }
  if (mod) return false;
  if (k === 'v') { ed.tool = 'select'; render(); return true; }
  if (k === 'b') { ed.tool = 'split'; render(); return true; }
  if (k === 'n') { ed.snap = !ed.snap; render(); return true; }
  if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); edSeek(S.mix.t + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1) / FPS24); return true; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); edDelete(); return true; }
  if (k === 'escape') { ed.sel = null; ed.editing = null; render(); return true; }
  return false;
}
// 预览画面里的卖点：拖动换位置，双击改字
document.addEventListener('pointerdown', e => {
  const pt = e.target.closest && e.target.closest('.cp-pt'); if (!pt || S.screen !== 'mix') return;
  e.preventDefault(); const fr = $('#cp-frame').getBoundingClientRect(), p = S.mix.points[+pt.dataset.pt];
  const move = ev => { p.x = Math.max(.1, Math.min(.9, (ev.clientX - fr.left) / fr.width)); p.y = Math.max(.08, Math.min(.94, (ev.clientY - fr.top) / fr.height)); pt.style.left = `${p.x * 100}%`; pt.style.top = `${p.y * 100}%`; };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
document.addEventListener('dblclick', e => {
  const pt = e.target.closest && e.target.closest('.cp-pt'); if (!pt) return;
  const i = +pt.dataset.pt, p = S.mix.points[i], r = pt.getBoundingClientRect();
  S.pop = { kind:'pkedit', i, rect:{ left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }, alignRight:false }; renderPop();
  const inp = $('#pop [data-pk-in]'); if (inp) { inp.value = p.text; inp.focus(); inp.select(); }
});
document.addEventListener('keydown', e => {
  const inp = e.target.closest && e.target.closest('[data-ed-in],[data-pk-in]'); if (!inp) return;
  if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
  if (e.key === 'Escape') { e.preventDefault(); S.mix.ed.editing = null; S.pop = null; render(); }
});
document.addEventListener('focusout', e => {
  const t = e.target;
  if (t.dataset && t.dataset.edIn) { const [kind, i] = t.dataset.edIn.split(':'), it = edList(kind)[+i]; if (it && it.text !== t.value) { edPush(); it.text = t.value; } S.mix.ed.editing = null; setTimeout(render, 0); }
  if (t.dataset && t.dataset.pkIn !== undefined && S.pop && S.pop.kind === 'pkedit') { const p = S.mix.points[S.pop.i]; if (t.value.trim() !== p.text) { edPush(); p.text = t.value.trim(); } S.pop = null; setTimeout(render, 0); }
});
// 缩放：拖动时局部重排，松手重绘
document.addEventListener('input', e => { if (e.target.dataset.edZoom !== undefined) { S.mix.ed.pps = +e.target.value; } });
document.addEventListener('change', e => { if (e.target.dataset.edZoom !== undefined) render(); });

// 右键菜单和快捷键说明
const popHookEd = popHook;
popHook = p => {
  if (p.kind === 'edmenu') {
    const it = (label, act, extra = '') => `<button class="menu-it" data-act="${act}" ${extra}><i class="menu-sp"></i><span>${label}</span></button>`;
    if (p.what === 'nar') return `<div class="menu menu-log ed-menu"><h5>口播音频变速</h5><div class="fg">${rng('倍速', 'mix.nar.rate', .5, 2, .1, 'rx')}</div><div class="seg sm presets">${[.8, 1, 1.2, 1.5].map(v => `<button class="${Math.abs(S.mix.nar.rate - v) < .01 ? 'on' : ''}" data-act="setv" data-k="mix.nar.rate" data-v="${v}">${v}x</button>`).join('')}</div><p class="plain">拖动后立即作用于当前音轨，松手自动保存。</p></div>`;
    if (p.what === 'clip') return `<div class="menu">${it('截取时段（双击）', 'edTrimOpen')}${it('删除片段（保留空位）', 'edDel')}</div>`;
    if (p.what === 'sub') return `<div class="menu">${it('编辑文案（双击）', 'edEditOpen')}${it('删除字幕', 'edDel')}</div>`;
    if (p.what === 'pt') return `<div class="menu">${it('编辑文案（双击）', 'edEditOpen')}${it('删除卖点', 'edDel')}</div>`;
    if (p.what === 'bgm') return `<div class="menu">${it('删除音频片段（保留空位）', 'edDel')}</div>`;
  }
  if (p.kind === 'pkedit') return `<div class="menu menu-pk"><input class="in" data-pk-in placeholder="留空则不显示"><p class="plain">回车保存，Esc 取消</p></div>`;
  if (p.kind === 'edhelp') return `<div class="menu menu-log"><h5>快捷键说明</h5><dl class="keys"><dt>空格</dt><dd>播放、暂停</dd><dt>V</dt><dd>选择工具</dd><dt>B</dt><dd>分割工具：点击视频、音频或字幕的目标位置切开</dd><dt>⌘/Ctrl + B</dt><dd>在播放头分割选中片段</dd><dt>N</dt><dd>视频磁吸开关，按住 Alt 临时关闭</dd><dt>← →</dt><dd>播放头移动 1 帧，按住 Shift 移动 10 帧</dd><dt>Delete</dt><dd>删除选中（视频保留空位）</dd><dt>⌘/Ctrl + Z</dt><dd>撤销，加 Shift 重做</dd><dt>Esc</dt><dd>取消选中</dd></dl><p class="plain">拖动字幕块移动，拖两侧修剪，双击改字；选中视频可在右侧调整倍速和画面，音频用分割工具裁切，右键删除。</p></div>`;
  return popHookEd(p);
};

// ---------- 点击 ----------
Object.assign(acts, {
  mixPlay: () => { const m = S.mix, v = film(); if (v.paused) { if (m.t >= FILM.dur - .05) edSeek(0); try { v.currentTime = m.t; } catch { /* 还没就绪 */ } v.playbackRate = m.nar.rate; v.play().catch(() => toast('浏览器拦下了自动播放，再点一次')); m.playing = true; } else { v.pause(); m.playing = false; } render(); },
  edTool: t => { S.mix.ed.tool = t.dataset.v; render(); },
  edSnap: () => { S.mix.ed.snap = !S.mix.ed.snap; render(); },
  edUndo: () => { const e = S.mix.ed; const s = e.hist.pop(); if (!s) return; e.fut.push(edSnapshot()); edRestore(s); render(); },
  edRedo: () => { const e = S.mix.ed; const s = e.fut.pop(); if (!s) return; e.hist.push(edSnapshot()); edRestore(s); render(); },
  edAddPoint: () => { const m = S.mix, t0 = Math.max(m.t, COVER_SEC), s = m.subs.find(x => m.t >= x.t0 && m.t < x.t1) || m.subs[0]; edPush(); m.points.push({ t0, t1:Math.min(FILM.dur, t0 + 2), text:s ? s.text : '新卖点', x:.5, y:.66 }); m.points.sort((a, b) => a.t0 - b.t0); m.ed.sel = { kind:'pt', i:m.points.findIndex(p => p.t0 === t0) }; toast('已在播放头处新增卖点'); render(); },
  edHelp: t => { S.pop = { kind:'edhelp', rect:t.getBoundingClientRect(), alignRight:true }; renderPop(); },
  edCol: t => { const k = t.dataset.v; S.mix.ed[k] = !S.mix.ed[k]; S.mix.ed.pps = 0; render(); },
  edView: t => { S.mix.ed.view = t.dataset.v; if (t.dataset.v === 'film') S.mix.ed.srcK = null; render(); },
  edMat: t => { const k = +t.dataset.v; S.mix.ed.mat = S.mix.ed.mat === k ? null : k; render(); },
  edPrevMat: t => { const e = S.mix.ed; e.srcK = +t.dataset.v; e.view = 'src'; if (S.mix.playing) acts.mixPlay(); render(); },
  edReplace: () => { const m = S.mix, c = edSelClip(), k = m.ed.mat; if (!c || !k) return; edPush(); const len = (c.t1 - c.t0) * (c.rate || 1); Object.assign(c, { k, img:`p${k}`, name:`${SHOT_NAME[k]}.mp4`, srcDur:SRC_DUR[k], inPt:Math.min(c.inPt || 0, Math.max(0, SRC_DUR[k] - len)) }); toast(`已用 ${SHOT_NAME[k]} 替换当前片段`); render(); },
  edInsert: () => { const m = S.mix, g = edGaps()[0], k = m.ed.mat; if (!g || !k) return; edPush(); const c = { k, img:`p${k}`, name:`${SHOT_NAME[k]}.mp4`, src:'视频生成', t0:g.t0, t1:Math.min(g.t1, g.t0 + SRC_DUR[k] - .3), inPt:.3, srcDur:SRC_DUR[k], rate:1, fz:1, fx:0, fy:0 }; m.clips.push(c); m.clips.sort((a, b) => (a.cover ? -1 : b.cover ? 1 : a.t0 - b.t0)); m.ed.sel = { kind:'clip', i:m.clips.indexOf(c) }; toast('已添加到缺口'); render(); },
  edDel: () => { S.pop = null; edDelete(); },
  edTrimOpen: () => { const s = S.mix.ed.sel; S.pop = null; if (!s) return; S.trim = { scope:'mix', i:s.i, inPt:S.mix.clips[s.i].inPt || 0 }; render(); },
  edEditOpen: () => { const s = S.mix.ed.sel; S.pop = null; if (!s) return; S.mix.ed.editing = { kind:s.kind, i:s.i }; render(); const inp = $(`[data-ed-in="${s.kind}:${s.i}"]`); if (inp) { inp.focus(); inp.select(); } },
  trimCancel: () => { S.trim = null; S.bt.trimIn = null; render(); },
  trimDone: () => {
    const tr = S.trim; if (!tr) return;
    if (tr.scope === 'mix') { edPush(); S.mix.clips[tr.i].inPt = tr.inPt; }
    else { const f = btFilm(); btSnap(); f.clips[tr.i].inPt = tr.inPt; btEdited(f); }
    S.trim = null; S.bt.trimIn = null; toast('已应用新的截取时段'); render();
  },
});
// 预览的大小随窗口变，时间轴首次按宽度铺满
const afterEd = Views.after;
Views.after = () => {
  afterEd();
  if (S.screen === 'mix' && S.mix.step === 2) {
    const sc = $('.ed-scroll');
    if (sc && !S.mix.ed.pps) { S.mix.ed.pps = Math.max(40, Math.min(240, Math.floor((sc.clientWidth - 30) / FILM.dur))); return render(); }
    if (sc) { if (edScrollX != null) sc.scrollLeft = edScrollX; sc.onscroll = () => { edScrollX = sc.scrollLeft; }; }
    cpMount(); edLive();
  } else if (!(S.screen === 'batch')) cpMount();
};
let edScrollX = null;

// ---------- 单条导出：点成片预览（播放真实导出的成片，有声音） ----------
function mixPvSheet() {
  const v = typeof filmEl !== 'undefined' && filmEl, playing = v && !v.paused;
  const body = `<div class="pv-wrap"><div class="pv-left"><div class="pv-film"><div id="film-slot"></div></div>
      <div class="pv-bar" data-pv-seek="mix" title="点击或拖动，跳到这个时间"><i id="pv-fill" style="width:${((v ? v.currentTime : 0) / FILM.dur * 100).toFixed(2)}%"></i></div>
      <div class="transport"><button class="play" data-act="mixPvPlay" title="空格">${ic(playing ? 'pause' : 'play')}</button><span><span data-pv-time>${fmtT(v ? v.currentTime : 0)}</span> <small>/ ${fmtT(FILM.dur)}</small></span></div></div>
    <div class="pv-side"><div class="fg"><div class="kv"><span>时长</span><span>17.3 秒</span></div><div class="kv"><span>画幅</span><span>3:4，1728×2304</span></div><div class="kv"><span>包装</span><span>${S.mix.pk.on ? TPL_INFO[S.mix.pk.tpl].name : '未启用'}</span></div><div class="kv"><span>文件名</span><span class="mono">20261107-B店-LH122K3-B1-AI种草-PUIKIN-k1f1.mp4</span></div></div><p class="note">这是真实导出的成片，有声音。</p></div></div>`;
  return sheet('成片预览', '', body, '<button class="btn" data-act="toastMsg" data-v="原型里不真的下载。正式版存到客户端设置的下载目录。">下载成片</button><button class="btn" data-act="toastMsg" data-v="原型里不真的下载。正式版存到客户端设置的下载目录。">下载封面</button><span class="sh-err"></span><button class="btn pri" data-act="mixPvClose">关闭</button>', 'pv-sheet');
}
Object.assign(acts, {
  mixPv: () => { S.mix.pv = true; const v = film(); try { v.currentTime = 0; } catch { /* 还没就绪 */ } v.playbackRate = 1; v.play().catch(() => {}); render(); }, // 先开始播放再画按钮，图标才对
  mixPvPlay: () => { const v = film(); if (v.paused) v.play().catch(() => {}); else v.pause(); render(); },
  mixPvClose: () => { const v = film(); v.pause(); S.mix.pv = false; S.mix.playing = false; render(); },
});
(function pvTick() {
  if (S.mix.pv && typeof filmEl !== 'undefined' && filmEl) { $$('[data-pv-time]').forEach(el => { el.textContent = fmtT(filmEl.currentTime); }); const fill = $('#pv-fill'); if (fill) fill.style.width = `${(filmEl.currentTime / FILM.dur * 100).toFixed(2)}%`; }
  requestAnimationFrame(pvTick);
})();
// 预览的进度条：点一下跳过去，按住可以拖
document.addEventListener('pointerdown', e => {
  const bar = e.target.closest && e.target.closest('[data-pv-seek]'); if (!bar || e.button !== 0) return;
  e.preventDefault(); const r = bar.getBoundingClientRect(), mix = bar.dataset.pvSeek === 'mix';
  const seek = x => {
    const p = Math.max(0, Math.min(1, (x - r.left) / r.width));
    if (mix) { const v = film(); try { v.currentTime = p * (FILM.dur - .05); } catch { /* 还没就绪 */ } }
    else { const pv = S.bt.pv, f = btFilms()[pv.fi]; pv.t = p * (f.dur - .02); btLive(); }
    const fill = $('#pv-fill'); if (fill) fill.style.width = `${(p * 100).toFixed(2)}%`;
  };
  seek(e.clientX);
  const move = ev => seek(ev.clientX), up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
// 成片预览弹窗：空格播放或暂停；批量的预览用左右键换上一条、下一条
function pvKey(e) {
  const bt = S.screen === 'batch' && S.bt.pv != null, mix = S.screen === 'mix' && S.mix.pv; if (!bt && !mix) return false;
  if (e.code === 'Space') { e.preventDefault(); (bt ? acts.btPvPlay : acts.mixPvPlay)(); return true; }
  if (bt && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); acts.btPvNav({ dataset:{ d:e.key === 'ArrowLeft' ? -1 : 1 } }); return true; }
  return false;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !S.pop && S.mix.pv) acts.mixPvClose(); }, true);
