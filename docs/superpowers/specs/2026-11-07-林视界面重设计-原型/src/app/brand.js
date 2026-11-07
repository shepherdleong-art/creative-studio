// 品牌页骨架：两套共用结构，内容和长相各自给
const COPY_PAIRS = [
  ['资源池 media-upstream:a8da36b5… 尚未配置；请由管理员在资源池配置中确认容量与映射。', '可灵官方账号还没设名额，对应模型员工暂时用不了。'],
  ['SERVER CONSOLE / OVERVIEW，生产有序，状态清楚。', '运行总览。运行中，正常接收生成任务。'],
  ['让今天的灵感，成为作品。', '下午好，PUIKIN。3 条成片等你审。'],
  ['实际模型来自执行快照；等待中的配置不标为已调用。', '实际模型：待调用（尚未发送）'],
  ['异常中心', '出错的任务'],
  ['模型与并发', '模型与名额'],
];
function brandDoc(c) {
  const sw = ([n, hex, use]) => `<div class="bd-sw"><i style="background:${hex}"></i><b>${n}</b><code>${hex}</code>${use ? `<small>${use}</small>` : ''}</div>`;
  return `<div class="bd" data-scroll-top>
  <div class="bd-top"><div class="bd-in"><div class="bd-hero">${c.hero()}</div><div class="bd-idea"><h1>${c.idea}</h1><p>${c.ideaNote}</p><p class="bd-tag">主张：${TAGLINE}<br>副题：${SUBTITLE}</p></div></div></div>
  <div class="bd-in">
    <section><h2>标志</h2><p class="bd-p">${c.markNote}</p><div class="bd-marks"><figure class="bd-fig">${c.construct()}<figcaption>构造</figcaption></figure>${c.glyphs().map(([h, l, cls]) => `<figure class="bd-fig ${cls || ''}">${h}<figcaption>${l}</figcaption></figure>`).join('')}</div></section>
    <section><h2>标志和名字的组合</h2><div class="bd-locks">${c.lockups().map(([h, l, cls]) => `<figure class="bd-lock ${cls || ''}"><div>${h}</div><figcaption>${l}</figcaption></figure>`).join('')}</div><p class="bd-p">窗口左上角用 ${c.navSize}px。两端都写全名：林视创作台、林视控制台。文字里一律写「林视 Lin's Vision」。</p></section>
    <section><h2>应用图标</h2><div class="bd-sizes">${[128, 64, 48, 32, 24, 16].map(s => `<figure>${c.icon(s)}<figcaption>${s}</figcaption></figure>`).join('')}</div>
      <div class="bd-trays"><figure><div class="bd-task">${[0, 1, 2].map(() => '<i></i>').join('')}<span class="on">${c.icon(32)}</span><i></i></div><figcaption>Windows 任务栏，32px，员工电脑上的样子</figcaption></figure>
      <figure><div class="bd-task dark">${[0, 1, 2].map(() => '<i></i>').join('')}<span class="on">${c.icon(32)}</span><i></i></div><figcaption>Windows 深色任务栏</figcaption></figure>
      <figure><div class="bd-dock">${[0, 1, 2].map(() => '<i></i>').join('')}<span>${c.icon(48)}</span><i></i></div><figcaption>Mac 程序坞，48px</figcaption></figure></div></section>
    <section><h2>颜色</h2><p class="bd-p">${c.colorNote}</p>${c.colors.map(g => `<h3>${g.title}</h3><div class="bd-sws">${g.items.map(sw).join('')}</div>`).join('')}</section>
    <section><h2>字体</h2><p class="bd-p">${c.fontNote}</p><div class="bd-fonts">${c.fonts.map(([p, f, n]) => `<div><b>${p}</b><span>${f}</span><small>${n}</small></div>`).join('')}</div>
      <div class="bd-scale">${c.scale.map(([l, st, s]) => `<div><small>${l}</small><span style="${st}">${s}</span></div>`).join('')}</div></section>
    <section><h2>控件</h2><p class="bd-p">${c.kitNote}</p><div class="bd-kit">${c.kit()}</div></section>
    <section><h2>说话方式</h2><p class="bd-p">直接说事实和下一步。不写口号，不把内部编号和技术词露给人看。</p><div class="bd-copy"><div class="bd-copy-h"><span>原来</span><span>现在</span></div>${COPY_PAIRS.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('')}</div></section>
    <section><h2>物料</h2><p class="bd-p">品牌感只放在这里和登录页。工作页不放。</p><div class="bd-coll"><figure>${c.splash()}<figcaption>启动画面</figcaption></figure><figure>${c.ppt()}<figcaption>汇报封面</figcaption></figure><figure>${c.badge()}<figcaption>工牌</figcaption></figure></div></section>
    <section><h2>不要这样用</h2><div class="bd-dont">${c.donts().map(([h, t]) => `<figure><div>${h}</div><figcaption>${t}</figcaption></figure>`).join('')}</div></section>
    <p class="bd-foot">未做商标检索。「林视」的中文名和图形要正式注册前，需要另做一次检索。</p>
  </div></div>`;
}
