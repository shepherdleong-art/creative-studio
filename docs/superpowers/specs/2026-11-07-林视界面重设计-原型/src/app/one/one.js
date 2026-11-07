// 方案一 Mac 原生：各屏的长相
const SCHEME = { name:'方案一 Mac 原生', compactReview:true };
const batch2 = () => S.batch === '2'; // 第一批不带「待审、通过/重做、多版本比较」
const pDetail = p => batch2() ? p.detail : p.detail.replace('待审', '已导出');
S.scene.view = 'cmp';
const markSVG = (s = 30) => `<svg class="mark" width="${s}" height="${s}" viewBox="0 0 100 100" aria-label="林视"><use href="#mark"/></svg>`;
const winCaps = () => `<span class="wincap"><i>—</i><i>▢</i><i>✕</i></span>`;
const statusDot = s => `<i class="dot ${statusKind(s)}"></i>`;
const markText = { ok:['ok','可用'], rework:['rework','待返工'], drop:['drop','废弃'], none:['none','未标记'] };
const selBtn = (id, val) => `<button class="pop" data-act="sel" data-v="${id}"><span>${esc(val)}</span>${ic('chevron-down')}</button>`;

function shell({ tb, body, status }) {
  const admin = S.role === 'admin';
  return `<div class="shell"><aside class="side"><div class="lights"><i></i><i></i><i></i></div>
    <button class="brand" data-act="go" data-v="${admin ? 'overview' : 'home'}">${markSVG()}<div><b>${admin ? '林视控制台' : '林视创作台'}</b><small>Lin's Vision</small></div></button>
    <nav class="navs" data-keep-scroll="nav">${NAV[S.role].map(g => `<div class="grp">${g.g}</div>${g.items.map(([v, l, i, n]) => `<button class="row ${navCurrent() === v ? 'on' : ''}" data-act="go" data-v="${v}">${ic(i)}<span>${l}</span>${n && !(admin && S.overviewEmpty) ? `<em>${n}</em>` : ''}</button>`).join('')}`).join('')}</nav>
    <button class="me" data-act="userMenu"><i>${admin ? '系' : 'P'}</i><span>${admin ? '系统管理员' : 'PUIKIN'}</span><small>${admin ? '0001' : '0102'}</small></button></aside>
  <div class="main"><header class="tb">${tb}${winCaps()}</header><div class="body">${body}</div>${status ? `<footer class="status">${status}</footer>` : ''}</div></div>`;
}
const projectTb = () => `<button class="cap ic" data-act="go" data-v="projects" title="返回">${ic('chevron-left')}</button>
  <div class="ttl"><b>${esc(S.project.code)} ${esc(S.project.type)}</b><small>${esc(S.project.full)}</small></div>
  <div class="seg">${STEPS.map(([v, l]) => `<button class="${S.screen === v || (v === 'mix' && S.screen === 'batch') ? 'on' : ''}" data-act="go" data-v="${v}">${l}</button>`).join('')}</div>
  <div class="caps"><button class="cap ic" data-act="logMenu" title="运行日志">${ic('logs')}</button><button class="cap ic" data-act="infoMenu" title="项目信息">${ic('settings')}</button><button class="cap" data-act="toastMsg" data-v="原型里不真的导出。正式版导出 ZIP，含分镜全部历史候选。">${ic('download')}导出</button></div>`;

const Views = {
  // ---------- 工作台 ----------
  home() {
    return shell({
      tb: `<div class="ttl"><b>下午好，PUIKIN</b><small>${batch2() ? '3 条成片等你审，' : ''}4 条还在生产，关掉窗口也不会停</small></div>
        <div class="caps"><button class="cap" data-act="go" data-v="projects">${ic('search')}找项目</button><button class="cap pri" data-act="newProject">${ic('plus')}新建项目</button></div>`,
      body: `<div class="pg">
        <div class="col">
          <div class="h4"><span>${batch2() ? `等你处理${newcap()}` : '出错的任务'}</span></div>
          <div class="fg">${WAITING.filter(w => batch2() || w.kind === 'bad').map(w => `<div class="wait-it"><img src="${A[w.img]}" alt=""><div><b>${esc(w.title)}</b><small>${esc(w.sub)}</small></div><span class="tag ${w.kind}">${w.label}</span><button class="btn ${w.kind === 'review' ? 'pri' : ''}" data-act="go" data-v="${w.go}">${w.cta}</button></div>`).join('')}</div>
          <div class="h4" style="margin-top:6px"><span>接着做</span><button data-act="go" data-v="projects">全部项目</button></div>
          <div class="tiles">${PROJECTS.slice(0, 8).map(p => `<button class="tile" data-act="openProject"><img src="${A[p.thumb]}" alt=""><div><b>${p.code}</b><small>${p.store} ${p.type}</small><small>第 ${p.step} 步 ${p.stepLabel}，${pDetail(p)}</small><div class="pips">${[1, 2, 3, 4, 5].map(n => `<i class="${n < p.step || (n === p.step && p.st === 'ok') ? 'y' : n === p.step ? (p.st === 'bad' ? 'b' : p.st === 'review' && batch2() ? 'w' : 'y') : ''}"></i>`).join('')}</div></div></button>`).join('')}</div>
        </div>
        <aside class="col">
          <div class="h4"><span>正在生产</span><button data-act="go" data-v="mytasks">我的任务</button></div>
          <div class="fg">${S.live.map((l, i) => `<div class="lv"><div><span>${esc(l.label)}</span><small data-live-num="${i}">${l.p}%</small></div><div class="bar"><i data-live-bar="${i}" style="width:${l.p}%"></i></div></div>`).join('')}</div>
          <div class="h4" style="margin-top:6px"><span>新建</span></div>
          <div class="fg">${CREATE.map(([n, t, i], x) => `<button class="mk" ${x === 0 ? 'data-act="newProject"' : 'data-act="toastMsg" data-v="这个入口这次没画，落地时照常保留。"'}>${ic(i)}<div><b>${n}</b><small>${t}</small></div></button>`).join('')}</div>
          <div class="h4" style="margin-top:6px"><span>本月用量</span><button data-act="go" data-v="usage">明细</button></div>
          <div class="fg"><div class="lv"><div><span>已用 ¥420.60</span><small>额度 ¥1000（示例）</small></div><div class="bar"><i style="width:42%"></i></div></div></div>
        </aside></div>`,
    });
  },
  // ---------- 我的项目 ----------
  projects() {
    const list = PROJECTS;
    return shell({
      tb: `<div class="ttl"><b>我的项目</b><small>${list.length} 个项目（示例）</small></div><div class="caps"><button class="cap pri" data-act="newProject">${ic('plus')}新建项目</button></div>`,
      body: `<div class="tblw"><div class="tbl" style="margin-top:12px"><div class="tr th t-proj"><span></span><span>项目</span><span>店铺</span><span>类型</span><span>进度</span><span>状态</span><span>花费</span><span>日期</span></div>
        <div class="rows">${list.map(p => `<button class="tr t-proj" data-act="openProject" style="min-height:50px"><img src="${A[p.thumb]}" alt=""><span>${p.full}</span><small>${p.store}</small><small>${p.type}</small><small>第 ${p.step} 步 ${p.stepLabel}</small><span>${{ review:batch2() ? '<i class="dot warn"></i>待审' : '<i class="dot"></i>已导出', run:'<i class="dot run"></i>生成中', bad:'<i class="dot bad"></i>有出错', ok:'<i class="dot"></i>已交付' }[p.st]}</span><small>${p.cost}</small><small>${p.date}</small></button>`).join('')}</div></div></div>`,
    });
  },
  // ---------- 第一步 选场景图 ----------
  scene() {
    const sc = S.scene, c = sceneCounts(), input = sc.inputs[sc.input], cur = sc.cands.find(x => x.id === sc.sel) || sc.cands[0];
    const cand = x => {
      const m = markText[x.mark];
      return `<figure class="cd ${sc.sel === x.id ? 'sel' : ''}" data-act="sceneSel" data-id="${x.id}">${x.running ? `<div class="ph"><span class="spin"></span>生成中</div>` : `<img src="${A[x.img]}" alt="${x.id}">`}${sc.ref === x.id ? '<span class="ref">场景参考图</span>' : ''}<figcaption><b>${x.id}</b><span>${x.running ? '第 2 轮' : `<i class="dot ${m[0]}"></i>${m[1]}`}</span></figcaption></figure>`;
    };
    const curMark = cur ? markText[cur.mark] : markText.none;
    const thumb = x => `<figure class="th-c ${sc.sel === x.id ? 'sel' : ''}" data-act="sceneSel" data-id="${x.id}">${x.running ? '<div class="ph"><span class="spin"></span></div>' : `<img src="${A[x.img]}" alt="${x.id}">`}${sc.ref === x.id ? '<span class="ref-s">参考</span>' : ''}<figcaption><b>${x.id}</b>${x.running ? '' : `<i class="dot ${markText[x.mark][0]}"></i>`}</figcaption></figure>`;
    return shell({
      tb: projectTb(),
      body: `<div class="sc">
        <section class="src"><h4>原始场景图<button data-act="sceneUpload" title="上传">${ic('plus')}</button></h4>
          ${sc.inputs.map((f, i) => `<button class="it ${sc.input === i ? 'on' : ''}" data-act="sceneInput" data-i="${i}"><img src="${A[f.img]}" alt=""><div><b>${esc(f.name)}</b><small>${sc.input === i ? '已选为输入' : esc(f.size)}</small></div></button>`).join('')}
          <button class="drop" data-act="sceneUpload" data-drop="scene">拖入图片或点击上传</button><input id="file-pick" type="file" accept="image/*" hidden></section>
        <section class="cand"><header><b>候选</b><small>${!c.total ? '还没有' : `${c.total} 张${c.run ? `，${c.run} 张生成中` : `，已选 ${sc.sel}`}`}</small><div class="seg sm"><button class="${sc.view === 'cmp' ? 'on' : ''}" data-act="sceneView" data-v="cmp">对照原图</button><button class="${sc.view === 'grid' ? 'on' : ''}" data-act="sceneView" data-v="grid">网格</button></div></header>
          ${!input ? `<div class="ph-pg"><b>先放一张原始场景图</b><span>放一张实拍或产品图，AI 换场景时会保持产品不变。</span><div class="ph-acts"><button class="btn pri" data-act="sceneUpload">上传图片</button><button class="btn" data-act="useSample">用示例数据继续看</button></div></div>`
            : !cur ? `<div class="cmp"><figure><div class="cmp-f"><img src="${A[input.img]}" alt="原图"></div><figcaption><b>原图</b><span>${esc(input.name)}</span></figcaption></figure><figure><div class="cmp-f"><div class="ph"><b>还没有候选</b><span>右边填好参数，生成第一批</span></div></div><figcaption><b>候选</b><span>0 张</span></figcaption></figure></div>`
            : sc.view === 'grid' ? `<div class="gr">${sc.cands.map(cand).join('')}</div>` : `<div class="cmp"><figure><div class="cmp-f"><img src="${A[input.img]}" alt="原图"></div><figcaption><b>原图</b><span>${esc(input.name)}</span></figcaption></figure><figure class="sel"><div class="cmp-f">${cur.running ? '<div class="ph"><span class="spin"></span>生成中</div>' : `<img src="${A[cur.img]}" alt="${cur.id}">`}${sc.ref === cur.id ? '<span class="ref">场景参考图</span>' : ''}</div><figcaption><b>${cur.id}</b><span>${cur.running ? '生成中' : `${cur.secs} 秒，<i class="dot ${curMark[0]}"></i>${curMark[1]}`}</span></figcaption></figure></div><div class="strip">${sc.cands.map(thumb).join('')}</div>`}
          ${!cur ? '' : `<div class="acts ${sc.view === 'cmp' ? 'inline' : ''}"><button class="${cur.mark === 'ok' ? 'on' : ''}" data-act="sceneMark" data-v="ok">${ic('check')}可用</button><button class="${cur.mark === 'rework' ? 'on' : ''}" data-act="sceneMark" data-v="rework">待返工</button><button class="${cur.mark === 'drop' ? 'on' : ''}" data-act="sceneMark" data-v="drop">废弃</button><hr><button data-act="sceneRegen">${ic('retry')}重新生成</button><button data-act="sceneRef">设为场景参考图</button><button data-act="sceneDl">${ic('download')}下载</button></div>`}
        </section>
        <aside class="insp" data-keep-scroll="insp">
          <div class="h4">生成参数</div>
          <div class="fg"><div class="fr"><span>家具类目</span>${selBtn('scene.cat', sc.cat)}</div><div class="fr"><span>场景</span>${selBtn('scene.room', sc.room)}</div></div>
          <div class="h4">场景提示词</div>
          <div class="fg"><textarea class="ta" rows="5" data-bind="scene.prompt">${esc(sc.prompt)}</textarea></div>
          <div class="h4">模型</div>
          <div class="fg"><div class="fr"><span>供应商</span>${selBtn('scene.provider', sc.provider.replace('公司网关 ', '').replace(' Medium', ''))}</div>
            <div class="fr"><span>数量</span><span class="stp">${sc.count}<div><button data-act="sceneStep" data-k="count" data-d="-1">−</button><button data-act="sceneStep" data-k="count" data-d="1">+</button></div></span></div></div>
          <p class="note">输出画幅 3:4，1728×2304，项目创建时锁定。一次最多 9 张。</p>
          <div style="flex:1"></div>
          <button class="go" data-act="sceneGen">生成 ${sc.count} 张新场景图</button>
        </aside></div>`,
      status: `<span><i class="dot ${c.run ? 'run' : ''}"></i><b>${c.run ? '生成中' : '队列空闲'}</b></span><span>等待 0</span><span>活跃 ${c.run}</span><span class="ok">成功 ${c.ok}</span><span>失败 0</span><span class="r">本项目已用 ¥75.09（示例）</span>`,
    });
  },
  // ---------- 智能混剪 ----------
  mix() {
    if (S.fresh) return shell({ tb: projectTb(), body: emptyStep('还没有可用视频', '先在视频生成里做好视频，这里才能混剪。', '<button class="btn pri" data-act="go" data-v="step4">去视频生成</button>') });
    const m = S.mix, names = ['导入素材', 'AI 智能创作', '预览调整', '导出渲染'];
    const sub = `<div class="subbar"><div class="seg sm mode-seg"><button class="on">单条精准混剪</button><button data-act="go" data-v="batch">批量生产</button></div>${names.map((l, i) => `<button class="crumb ${m.step === i ? 'on' : ''} ${i < m.step ? 'done' : ''}" data-act="mixStep" data-v="${i}"><i>${i < m.step ? ic('check') : i + 1}</i>${l}</button>`).join('')}<span class="r">${m.step === 2 ? `${m.clips.length - 1} 片段，总时长 17.3 秒<span class="tag ok">口播 16.4 秒</span><button class="btn pri" data-act="mixStep" data-v="3">下一步：导出</button>` : ''}</span></div>`;
    return shell({ tb: projectTb(), body: `<div style="height:100%;display:flex;flex-direction:column">${sub}${[mixImport, mixCreate, mixEditor, mixExport][m.step]()}</div>${S.coverEdit && S.coverEdit.scope === 'mix' ? coverSheet() : ''}${S.mix.pv ? mixPvSheet() : ''}` });
  },
  // ---------- 运行总览 ----------
  overview() {
    const e = S.overviewEmpty, k = metrics(), pc = poolCounts();
    const rows = S.taskData.slice(0, 18);
    return shell({
      tb: `<div class="ttl"><b>运行总览</b><small><i class="dot ${S.paused ? 'warn' : ''}"></i>${S.paused ? '已暂停，新生成任务等待中' : '运行中，正常接收生成任务'}</small></div>
        <div class="caps"><button class="cap" data-act="go" data-v="tasks">${ic('search')}找任务</button><button class="cap" data-act="toastMsg" data-v="已刷新。这里每 30 秒自动更新。">${ic('retry')}刷新</button><button class="cap ${S.paused ? 'pri' : ''}" data-act="pauseAsk">${S.paused ? '恢复运行' : '暂停运行'}</button></div>`,
      body: `<div class="ov"><section class="ov-m">
          <div class="mets"><div><b>${k.run}</b>进行中</div><div><b>${k.wait}</b>等待中</div><div><b>${k.done}</b>今天已完成</div><div><b>${k.check}</b>待核查</div></div>
          ${e ? `<div class="tbl" style="display:grid;place-items:center"><div class="empty"><svg class="mkw" viewBox="0 0 100 100"><use href="#leaf"/></svg>还没有生产任务。<br>右边三件事配好，成员就能开工。</div></div>`
            : `<div class="tbl"><div class="tr th t-task"><span>任务</span><span>项目</span><span>发起人</span><span>模型</span><span>状态</span><span>时间</span></div><div class="rows">${rows.map(t => `<button class="tr t-task" data-act="overviewRow" data-id="${t.id}"><span>${t.mod} ${t.step}</span><small>${t.proj}</small><span>${t.actor}</span><small>${t.model}</small><span>${statusDot(t.status)}${statusLabel(t.status)}</span><small>${t.time}</small></button>`).join('')}</div></div>`}
        </section>
        <aside class="rail">
          ${e ? `<div class="h4">开工前还差 2 件事</div><div class="fg">${SETUP.map((s, i) => `<div class="st-it"><i class="${s.ok ? 'y' : ''}">${s.ok ? ic('check') : i + 1}</i><div><b>${s.label}<span>${s.state}</span></b><p>${s.note}</p>${s.cta ? `<button data-act="go" data-v="${s.go}">${s.cta}</button>` : ''}</div></div>`).join('')}</div>`
            : `<div class="h4"><span>模型名额</span><button data-act="go" data-v="pools">管理</button></div>
          <div class="fg">${S.pools.filter(p => p.state === 'ready').map(p => `<div class="lv"><div><span>${p.name}</span><small>${p.held} / ${p.cap}</small></div><div class="bar"><i style="width:${p.cap ? p.held / p.cap * 100 : 0}%"></i></div></div>`).join('')}</div>
          ${pc.missing + pc.cred ? `<div class="tip">${pc.missing ? `${pc.missing} 个账号还没设名额` : ''}${pc.missing && pc.cred ? '，' : ''}${pc.cred ? `${pc.cred} 个缺密钥` : ''}，对应模型员工暂时用不了。<button data-act="go" data-v="pools">去设置</button></div>` : ''}
          <div class="h4" style="margin-top:4px">服务</div>
          <div class="fg"><div class="kv"><span>公司模型代理</span><span style="color:var(--ok)">已就绪</span></div><div class="kv"><span>参考图中转</span><span style="color:var(--ok)">已配置</span></div><div class="kv"><span>今日备份</span><span>02:30 成功</span></div></div>
          <div class="h4" style="margin-top:4px"><span>今天的成员</span><button data-act="go" data-v="ausage">用量</button></div>
          <div class="fg">${[['PUIKIN', '8 条在产', '¥126'], ['ALAN', '3 条在产', '¥46'], ['可华', '2 条在产，1 处出错', '¥45'], ['强尼', '1 条在产', '¥64']].map(([n, s, c]) => `<div class="kv"><span>${n}<small style="display:block;color:var(--sec);font-size:12.5px">${s}</small></span><span>${c}</span></div>`).join('')}</div>`}
        </aside></div>`,
      status: e ? `<span>服务器上还没有任务</span><span class="r">每 30 秒更新</span>` : `<span>显示最近 18 条，共 104 条（示例）</span><span class="r">每 30 秒更新</span>`,
    });
  },
  // ---------- 全员任务 ----------
  tasks() { return taskPage('全员任务', '按项目、步骤和发起人找任务。'); },
  mytasks() { return taskPage('我的任务', '任务在服务器上跑，关掉窗口也不会停。'); },
  errors() { return taskPage('出错的任务', '系统自动捕获失败并关联任务，不用填错误码。'); },
  // ---------- 模型与名额 ----------
  pools() {
    const pc = poolCounts();
    return shell({
      tb: `<div class="ttl"><b>模型与名额</b><small>${pc.ready} 个账号可以用，${pc.missing} 个没设名额，${pc.cred} 个缺密钥</small></div><div class="caps"><button class="cap" data-act="go" data-v="settings">${ic('settings')}供应商配置</button></div>`,
      body: `<div class="pl" data-keep-scroll="pl"><div class="pl-in"><p class="lead"><b>名额就是同时能跑几条。</b>同一个账号下的模型共用名额，所以只按账号设一次。调低名额不会打断正在跑的任务，新任务按新名额排队。</p>
        ${S.pools.map(p => {
          const open = S.poolOpen === p.name, st = !p.on ? 'off' : p.state, kind = { ready:'ok', missing:'warn', credential:'bad', off:'off' }[st];
          return `<article class="pcard"><div class="phead"><div><b>${p.name}</b><small>${p.kind}，${p.models.length} 个模型${p.models.length > 1 ? '共用' : ''}：${p.models.slice(0, 3).join('、')}${p.models.length > 3 ? ' 等' : ''}</small></div>
            ${p.state === 'credential' ? `<button class="btn" data-act="go" data-v="settings" style="justify-self:start">去填密钥</button>` : `<div class="capin"><button data-act="poolStep" data-n="${p.name}" data-d="-1" aria-label="减少">−</button><input aria-label="${p.name}名额" inputmode="numeric" value="${esc(p.cap)}" data-dirty="${p.name}"><button data-act="poolStep" data-n="${p.name}" data-d="1" aria-label="增加">+</button></div>`}
            <div class="use"><small><span>正在用</span><span>${p.held} / ${+p.cap || 0}</span></small><div class="bar"><i style="width:${+p.cap ? Math.min(100, p.held / p.cap * 100) : 0}%"></i></div></div>
            <div>${p.dirty ? `<button class="btn pri" data-act="poolSave" data-n="${p.name}">保存</button>` : `<span class="tag ${kind}">${POOL_STATE[st]}</span>`}</div>
            <button class="switch ${p.on ? 'on' : ''}" data-act="poolToggle" data-n="${p.name}" aria-label="启用"></button>
            <button data-act="poolOpen" data-k="${p.name}" aria-label="展开" style="display:grid;place-items:center;color:var(--sec)">${ic(open ? 'chevron-down' : 'chevron-right')}</button></div>
            ${open ? `<div class="pbody"><div><h6>包含的模型</h6><div class="chips">${p.models.map(m => `<span>${m}</span>`).join('')}</div></div>
              <div><h6>谁在用</h6>${p.members.length ? `<div class="memb">${p.members.map(([n, h, q, r]) => `<span>${n}</span><small>占 ${h} 个，运行 ${r}，排队 ${q}</small>`).join('')}</div><p class="note" style="padding:6px 0 0">其中已受理 ${p.accepted}，结果待确认 ${p.maybe}，待发送 ${p.notSent}。结果没确认前继续占名额。</p>` : '<small style="color:var(--sec)">现在没人占用。</small>'}</div>
              ${p.key ? `<details class="pkey"><summary>排查用的内部编号</summary><code>${p.key}</code></details>` : ''}</div>` : ''}</article>`;
        }).join('')}
      </div></div>`,
    });
  },
  // ---------- 登录 ----------
  login() {
    const l = S.login, chg = l.mode === 'change', t = l.show ? 'text' : 'password';
    return `<div class="login" style="background-image:url(${A.s4})"><div class="lights lg-lights"><i></i><i></i><i></i></div><span class="lg-wincap"><i>—</i><i>▢</i><i>✕</i></span>
      <form class="lg-card" onsubmit="return false"><header>${markSVG(62)}<b>${chg ? '设置新密码' : '林视'}</b><small>${chg ? '首次或重置密码只能登录一次，设置新密码后进入工作台。' : "Lin's Vision"}</small></header>
      <div class="lg-f">
        ${chg ? `<div><label>新密码（至少 6 位，可用数字）</label><input type="${t}" data-bind="login.pw2" value="${esc(l.pw2)}" autocomplete="new-password"></div><div><label>确认新密码</label><input type="${t}" data-bind="login.pw3" value="${esc(l.pw3)}" autocomplete="new-password"></div>`
          : `<div><label>工号</label><input type="text" data-bind="login.id" value="${esc(l.id)}" autocomplete="username" placeholder="管理员发放的工号"></div><div><label>密码或 6 位一次性密码</label><input type="${t}" data-bind="login.pw" value="${esc(l.pw)}" autocomplete="current-password"></div>`}
        ${chg ? '' : `<button class="lg-chk ${l.remember ? 'on' : ''}" data-act="loginCheck" data-k="remember"><i>${ic('check')}</i>记住登录状态（30 天）</button>`}
        <button class="lg-chk ${l.show ? 'on' : ''}" data-act="loginCheck" data-k="show"><i>${ic('check')}</i>显示密码</button>
        ${l.err ? `<p class="lg-err" role="alert">${esc(l.err)}</p>` : ''}${l.info ? `<p class="lg-inf" role="status">${esc(l.info)}</p>` : ''}
        <button class="go" data-act="loginSubmit" style="margin-top:4px">${chg ? '保存新密码并进入' : '登录'}</button></div>
      ${chg ? '' : `<p class="lg-tag">${TAGLINE}</p>`}</form>
      <span class="lg-hint">示例：工号 0102 进创作台，0001 进控制台；密码填 6 位数字可看首次改密</span></div>`;
  },
  // ---------- 品牌页 ----------
  brand() { return brandDoc(BRAND_ONE); },
  // ---------- 这次没画的页 ----------
  placeholder() {
    const [title, note] = PLACEHOLDER[S.screen] || ['这一页', ''];
    const step = /^step/.test(S.screen);
    return shell({
      tb: step ? projectTb() : `<div class="ttl"><b>${title}</b><small>${note}</small></div>`,
      body: `<div class="ph-pg"><b>${title}</b><span>${note}</span><span>这一页不做原型，落地时按同样的规则延伸，功能一个不少。</span>${step ? `<button class="btn" data-act="go" data-v="scene">回到场景图</button>` : ''}</div>`,
    });
  },
  after() {
    const g = $('.gr'); if (!g) return;
    const n = g.children.length, cols = n <= 4 ? 2 : Math.ceil(n / 2), H = g.clientHeight - 68, W = g.clientWidth - 16, gx = 18, gy = 10, cap = 24;
    let h = (H - gy - 2 * cap) / 2, w = h * .75;
    if (w * cols + gx * (cols - 1) > W) { w = (W - gx * (cols - 1)) / cols; h = w / .75; }
    g.style.setProperty('--tw', Math.max(90, w) + 'px'); g.style.setProperty('--th', Math.max(120, h) + 'px'); g.style.gridTemplateColumns = `repeat(${cols},var(--tw))`;
  },
};

function taskPage(title, note) {
  const list = taskList(), sel = S.taskData.find(t => t.id === S.tasks.sel), all = S.screen === 'tasks';
  return shell({
    tb: `<div class="ttl"><b>${title}</b><small>${note}</small></div><div class="caps"><button class="cap" data-act="toastMsg" data-v="已刷新。">${ic('retry')}刷新</button></div>`,
    body: `<div class="split ${sel ? 'has' : ''}"><div class="tblw"><div class="fbar"><label class="search">${ic('search')}<input placeholder="项目名、步骤、模型、姓名" data-bind="tasks.q" data-live="text" value="${esc(S.tasks.q)}"></label>
        ${all ? `<button class="fbtn" data-act="sel" data-v="tasks.actor">发起人：${S.tasks.actor}${ic('chevron-down')}</button>` : ''}<button class="fbtn" data-act="sel" data-v="tasks.status">状态：${S.tasks.status}${ic('chevron-down')}</button>
        <small>${list.length} 条，最多显示最近 500 条</small></div>
      <div class="tbl">${list.length ? `<div class="tr th t-task"><span>任务</span><span>项目</span><span>发起人</span><span>模型</span><span>状态</span><span>时间</span></div><div class="rows">${list.map(t => `<button class="tr t-task ${S.tasks.sel === t.id ? 'on' : ''}" data-act="taskSel" data-id="${t.id}"><span>${t.mod} ${t.step}</span><small>${t.proj}</small><span>${t.actor}</span><small>${t.model}</small><span>${statusDot(t.status)}${statusLabel(t.status)}</span><small>${t.time}</small></button>`).join('')}</div>` : `<div class="empty">没有符合条件的任务。<br><button class="btn" style="margin-top:10px" data-act="taskClearFilter">清除筛选</button></div>`}</div></div>
      ${sel ? `<aside class="detail" data-keep-scroll="detail"><div class="dt-h">${sel.mod} ${sel.step}</div>
        ${sel.err ? `<div class="tip bad">这一步失败了，错误编号 ${sel.err}。重试不会重复扣已成功的部分。</div>` : ''}${['unknown', 'maybe_sent'].includes(sel.status) ? `<div class="tip">结果还没确认。先核对结果，再决定重试，避免重复扣费。</div>` : ''}
        <div class="fg"><div class="kv"><span>状态</span><span>${statusDot(sel.status)}${statusLabel(sel.status)}</span></div><div class="kv"><span>项目</span><span>${sel.proj}</span></div><div class="kv"><span>发起人</span><span>${sel.actor}</span></div><div class="kv"><span>供应商</span><span>${sel.provider}</span></div><div class="kv"><span>实际模型</span><span>${sel.calls[0].model ? sel.model : '待调用（尚未发送）'}</span></div><div class="kv"><span>任务编号</span><span>${sel.id}</span></div></div>
        <div class="h4">实际调用记录</div><div class="fg">${sel.calls.map(c => `<div class="call">${c.model || '未记录'}<small>${CALL_STATE[c.state]}，${c.time}</small></div>`).join('')}</div>
        <p class="note">调用记录不等于制作份数，也不等于扣费次数。</p>
        <div style="display:flex;gap:8px;margin-top:2px"><button class="btn" data-act="go" data-v="scene">打开项目</button>${sel.status === 'failed' ? `<button class="btn pri" data-act="taskRetry" data-id="${sel.id}">重试</button>` : ''}</div></aside>` : ''}</div>`,
  });
}

function mixImport() {
  const m = S.mix, n = m.used.filter(Boolean).length;
  return `<div class="pane"><div class="pane-in"><div class="h4" style="font-size:14px;color:var(--ink)"><span>确认本次混剪要用的素材</span><span style="font-weight:400;color:var(--sec);font-size:12.5px">${FILM.clips.length} 个可用视频，${n} 个将参与混剪</span></div>
    <p class="note">当前分镜组的完成视频默认全部参与，点卡片排除。只用当前组的视频，其他分镜组不会混入。</p>
    <div class="mat">${FILM.clips.map((c, i) => `<button class="${m.used[i] ? '' : 'off'}" data-act="mixUsed" data-i="${i}" title="${m.used[i] ? '点击排除' : '点击恢复'}"><img src="${A[c.img]}" alt=""><i>${ic('check')}</i><small>${esc(c.name)}</small></button>`).join('')}</div>
    <div style="display:flex;justify-content:flex-end"><button class="btn pri" data-act="mixStep" data-v="1">下一步：AI 智能创作</button></div></div></div>`;
}
function mixCreate() {
  const m = S.mix;
  return `<div class="pane"><div class="pane-in"><div class="two"><div style="display:flex;flex-direction:column;gap:9px"><div class="h4">口播文案<span style="font-weight:400">目标 15 到 30 秒，总时长包含封面</span></div><div class="fg"><textarea class="ta" rows="6" data-bind="mix.script">${esc(m.script)}</textarea></div>
      <div class="h4">朗读音色</div><div class="fg">${VOICES.map(([n, d], i) => `<button class="voice ${m.voice === i ? 'on' : ''}" data-act="mixVoice" data-i="${i}"><i></i><div>${n}<small>${d}</small></div></button>`).join('')}</div></div>
    <div style="display:flex;flex-direction:column;gap:9px"><div class="h4">智能创作进度</div><div class="fg">${CREATE_STAGES.map(s => `<div class="stg">${ic('check')}${s}</div>`).join('')}</div><p class="note">任务快照已保存，刷新页面不会丢失。</p><div style="display:flex;gap:8px"><button class="btn" data-act="toastMsg" data-v="已提交再生成一版（示例）。">再生成一版</button><button class="btn pri" data-act="mixStep" data-v="2">去预览调整</button></div></div></div></div></div>`;
}
function mixExport() {
  const e = S.mix.exp;
  const name = '20261107-B店-LH122K3-B1-AI种草-PUIKIN-k1f1.mp4';
  return `<div class="pane"><div class="pane-in"><div class="two"><div style="display:flex;flex-direction:column;gap:9px"><div class="h4">导出前检查</div><div class="fg"><div class="kv"><span>时间轴</span><span style="color:var(--ok)">已就绪，${S.mix.clips.length - 1} 片段</span></div><div class="kv"><span>字幕</span><span style="color:var(--ok)">已就绪，${S.mix.subs.length} 条</span></div><div class="kv"><span>配乐</span><span>沿用原片配乐</span></div><div class="kv"><span>包装</span><span>${S.mix.pk.on ? TPL_INFO[S.mix.pk.tpl].name : '未启用'}</span></div><div class="kv"><span>文件名</span><span style="font-size:12.5px;word-break:break-all">${name}</span></div></div>
      ${e.state === 'idle' ? `<button class="go" data-act="mixExport">导出并写回项目</button><p class="note">成片和封面会保留渲染副本，写入当前项目的成片目录。</p>` : ''}
      ${e.state === 'done' ? `<div class="tip" style="background:var(--ok-t);color:var(--ok)">导出完成，已写回项目。</div><div style="display:flex;gap:8px"><button class="btn" data-act="toastMsg" data-v="原型里不真的打开文件夹。">打开文件夹</button><button class="btn" data-act="mixExport">再导出一次</button></div>` : ''}</div>
    <div style="display:flex;flex-direction:column;gap:9px">${e.state === 'idle' ? `<div class="h4">渲染进度</div><div class="fg"><div class="stg wait"><i class="o"></i>尚未开始</div></div>` : e.state === 'run' ? `<div class="h4">渲染进度</div><div class="fg">${EXPORT_STAGES.map((s, i) => `<div class="stg ${i > e.i ? 'wait' : ''}">${i < e.i ? ic('check') : i === e.i ? '<span class="spin"></span>' : '<i class="o"></i>'}${s}</div>`).join('')}</div>`
      : !batch2() ? `<div class="h4">成片</div><div class="vers solo"><figure class="cur pv-fig" data-act="mixPv" title="点击预览成片"><img src="${A.f3}" alt=""><span class="bfc-play">${ic('play')}</span><figcaption>这次的成片</figcaption></figure></div><p class="note">17.3 秒，3:4，已写入项目的成片目录。点击成片可以预览。</p><div class="rc-btns"><button class="btn sm" data-act="toastMsg" data-v="原型里不真的下载。正式版存到客户端设置的下载目录。">下载成片</button><button class="btn sm" data-act="toastMsg" data-v="原型里不真的下载。正式版存到客户端设置的下载目录。">下载封面</button></div>`
      : `<div class="h4"><span>这一条能发吗${newcap()}</span></div><div class="vers"><figure><img src="${A.f1}" alt=""><figcaption>第 1 版</figcaption></figure><figure><img src="${A.f2}" alt=""><figcaption>第 2 版</figcaption></figure><figure class="cur"><img src="${A.f3}" alt=""><figcaption>第 3 版（这次）</figcaption></figure></div>${e.verdict === 'pass' ? '<div class="tip" style="background:var(--ok-t);color:var(--ok)">第 3 版已通过，可以交付。</div>' : `<div class="vbtns"><button class="btn pri" data-act="mixVerdict" data-v="pass">通过，交付</button><button class="btn" data-act="mixVerdict" data-v="redo">这条重做</button></div>`}`}</div></div></div></div>`;
}
