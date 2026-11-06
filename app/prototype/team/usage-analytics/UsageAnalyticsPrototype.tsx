'use client';

// THROWAWAY UI question: which hierarchy makes team quotas, model spend and member drilldown easiest to scan?
// All rows and charts are invented in-memory design data; no production component, database or provider is imported.
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import styles from './usage-prototype.module.css';

type Variant = 'local' | 'trend' | 'members';
const variants: Array<{ key: Variant; name: string; description: string }> = [
  { key: 'local', name: '本地版分区', description: '按额度、筛选、模型统计、成员明细顺序阅读' },
  { key: 'trend', name: '趋势优先', description: '先判断花费走向，再看模型和成员归属' },
  { key: 'members', name: '成员优先', description: '先看每个人的额度与消费，右侧显示模型分布' },
];
const modelRows = [
  { name: 'Seedance 2.5', category: '视频生成', calls: 68, amount: '¥1,302.00', ratio: 60.5, tone: 'blue' },
  { name: 'GPT-5-6-Luna', category: '脚本与文本', calls: 52, amount: '¥616.85', ratio: 28.7, tone: 'violet' },
  { name: 'image2-medium', category: '图片生成', calls: 41, amount: '¥232.88', ratio: 10.8, tone: 'pink' },
];
const memberRows = [
  { id: 'alice', name: '林小满', employeeId: '00128', role: '员工', calls: 68, amount: '¥324.80', limit: '¥500.00', remaining: '¥175.20', ratio: 65 },
  { id: 'bob', name: '陈墨', employeeId: '00136', role: '员工', calls: 45, amount: '¥126.30', limit: '不限额', remaining: '不限额', ratio: 0 },
  { id: 'admin', name: 'Administrator', employeeId: '12089', role: '管理员', calls: 48, amount: '¥68.00', limit: '¥300.00', remaining: '¥232.00', ratio: 23 },
];
const calls = [
  ['11-04 15:00', 'GPT-5-6-Luna', '脚本与文本生成', '¥92.95'],
  ['11-04 11:00', 'Seedance 2.5', '视频生成', '¥186.00'],
  ['11-03 14:00', 'GPT-5-6-Luna', '脚本与文本生成', '¥76.05（预估）'],
  ['11-03 10:00', 'image2-medium', '图片生成', '¥29.52'],
];

function moneyLabel(value: string) { return <span className={styles.money}>{value}</span>; }

function SectionTitle({ eyebrow, title, note, aside }: { eyebrow?: string; title: string; note?: string; aside?: string }) {
  return <div className={styles.sectionTitle}><div>{eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}<h2>{title}</h2>{note && <p>{note}</p>}</div>{aside && <span className={styles.sectionAside}>{aside}</span>}</div>;
}

function QuotaSummary({ compact = false }: { compact?: boolean }) {
  const stats = [
    ['本月团队已计', '¥519.10', '已结算 ¥394.50'],
    ['有限额度合计', '¥800.00', '2 位有限额度成员'],
    ['有限额度剩余', '¥408.90', '另有 1 位不限额'],
    ['待结算预留', '¥124.60', '已包含在本月已计'],
  ];
  return <section className={`${styles.panel} ${compact ? styles.compactQuota : ''}`}>
    <SectionTitle title="团队额度" note="北京时间自然月 · 不随用量筛选变化" aside="2026 年 11 月" />
    <div className={styles.quotaStats}>{stats.map(([label, amount, note]) => <div key={label}><span>{label}</span><strong>{amount}</strong><small>{note}</small></div>)}</div>
  </section>;
}

function Filters() {
  const [period, setPeriod] = useState('本月');
  return <div className={styles.filterBar}>
    <div className={styles.periods} role="group" aria-label="原型日期范围">{['今日', '近 7 天', '本周', '本月', '自选日期'].map(label => <button key={label} aria-pressed={period === label} onClick={() => setPeriod(label)}>{label}</button>)}</div>
<div className={styles.filterFields}><select aria-label="原型模型筛选" defaultValue=""><option value="">全部模型</option>{modelRows.map(row => <option key={row.name}>{row.name}</option>)}</select><select aria-label="原型结果筛选"><option>全部结果</option><option>成功</option><option>失败</option></select><button className={styles.refresh}><Icon name="retry" size={14} />刷新</button></div>
  </div>;
}

function TrendChart({ large = false }: { large?: boolean }) {
  return <div className={`${styles.chartBox} ${large ? styles.largeChart : ''}`}>
    <svg viewBox="0 0 600 250" role="img" aria-label="示例：11 月各模型费用趋势">
      {[20, 85, 150, 215].map((y, index) => <g key={y}><line className={styles.gridLine} x1="48" x2="590" y1={y} y2={y} /><text x="40" y={y + 4} textAnchor="end">{['¥160', '¥100', '¥40', '¥0'][index]}</text></g>)}
      {['11-01', '11-02', '11-03', '11-04'].map((date, index) => <text key={date} x={48 + index * 180} y="240" textAnchor={index === 3 ? 'end' : index === 0 ? 'start' : 'middle'}>{date}</text>)}
      <path className={`${styles.line} ${styles.blueStroke}`} d="M48 48 L228 78 L408 101 L588 38" />
      <path className={`${styles.line} ${styles.violetStroke}`} d="M48 108 L228 130 L408 147 L588 117" />
      <path className={`${styles.line} ${styles.pinkStroke}`} d="M48 176 L228 168 L408 156 L588 172" />
      <circle cx="588" cy="38" r="4" className={styles.blueFill} /><text x="578" y="29" textAnchor="end" className={styles.chartValue}>¥146</text>
    </svg>
    <div className={styles.legend}>{modelRows.map(row => <span key={row.name}><i className={styles[row.tone]} />{row.name}</span>)}</div>
  </div>;
}

function ModelTable({ compact = false }: { compact?: boolean }) {
  return <div className={styles.tableScroll}><table className={`${styles.table} ${compact ? styles.compactTable : ''}`}><thead><tr><th>模型 / 模块</th><th>调用</th><th>已计费用</th><th>占比</th></tr></thead><tbody>{modelRows.map(row => <tr key={row.name}>
    <td><div className={styles.modelName}><i className={styles[row.tone]} /><div><strong>{row.name}</strong><small>{row.category}</small></div></div></td><td>{row.calls} 次</td><td>{moneyLabel(row.amount)}</td><td><span>{row.ratio}%</span><div className={styles.track}><i className={styles[row.tone]} style={{ width: `${row.ratio}%` }} /></div></td>
  </tr>)}</tbody></table><p className={styles.uncertain}>未定价 1 次 · 不确定 1 次，不按零元计</p></div>;
}

function MemberTable({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  return <div className={styles.tableScroll}><table className={`${styles.table} ${styles.memberTable} ${compact ? styles.compactMembers : ''}`}><thead><tr><th>成员</th><th>调用</th><th>本月已计</th><th>月度额度</th><th>剩余可用</th><th /></tr></thead><tbody>{memberRows.map(member => <tr key={member.id}>
    <td><div className={styles.member}><span>{member.name[0]}</span><div><strong>{member.name}</strong><small>{member.employeeId} · {member.role}</small></div></div></td><td>{member.calls} 次</td><td>{moneyLabel(member.amount)}</td><td>{member.limit}{member.ratio > 0 && <div className={styles.track}><i style={{ width: `${member.ratio}%` }} /></div>}</td><td>{member.remaining}</td><td><button className={styles.textButton} onClick={onOpen} aria-label={`查看${member.name}的用量`}>查看用量 <Icon name="chevron-right" size={13} /></button></td>
  </tr>)}</tbody></table></div>;
}

function ModelTrendPanel({ stacked = false }: { stacked?: boolean }) {
  return <section className={styles.panel}><SectionTitle title="模型消耗排行" note="按当前日期和筛选范围汇总 · 含已结算与费用预留" aside="161 次调用 · ¥2,151.73" />
    <div className={`${styles.analysisGrid} ${stacked ? styles.stackedAnalysis : ''}`}><div><h3 className={styles.subheading}>每日模型费用</h3><TrendChart large={stacked} /></div><div><h3 className={styles.subheading}>模型费用统计</h3><ModelTable compact /></div></div>
  </section>;
}

function LocalVariant({ onOpen }: { onOpen: () => void }) {
  return <><QuotaSummary /><section className={styles.panel}><Filters /></section><ModelTrendPanel /><section className={styles.panel}><SectionTitle title="成员用量" note="点击成员查看其模型趋势与调用明细" aside="3 位成员" /><MemberTable onOpen={onOpen} /></section></>;
}

function TrendVariant({ onOpen }: { onOpen: () => void }) {
  return <><div className={styles.trendTop}><QuotaSummary compact /><section className={`${styles.panel} ${styles.totalSpend}`}><span>本月模型消耗</span><strong>¥2,151.73</strong><p>已结算 ¥1,506.89 · 预留 ¥589.08</p><div><span>视频 60.5%</span><span>文本 28.7%</span><span>图片 10.8%</span></div></section></div>
    <section className={styles.panel}><SectionTitle title="费用走向" note="先看团队的消耗趋势，再追溯模型和成员" aside="11 月 1 日—11 月 4 日" /><Filters /><TrendChart large /></section>
    <div className={styles.trendBottom}><section className={styles.panel}><SectionTitle title="模型花费" note="哪个模型贡献了费用" /><ModelTable compact /></section><section className={styles.panel}><SectionTitle title="成员花费" note="费用归属于谁" /><MemberTable onOpen={onOpen} compact /></section></div>
  </>;
}

function MembersVariant({ onOpen }: { onOpen: () => void }) {
  return <><QuotaSummary compact /><section className={styles.panel}><Filters /></section><div className={styles.membersLayout}>
    <section className={styles.panel}><SectionTitle title="成员用量" note="先选一位成员，查看额度与模型归属" /><MemberTable onOpen={onOpen} compact /></section>
    <aside className={styles.panel}><SectionTitle title="团队模型分布" note="全部成员 · 本月" /><div className={styles.donut}><div><strong>¥2,151.73</strong><span>本月已计</span></div></div><div className={styles.distribution}>{modelRows.map(row => <div key={row.name}><i className={styles[row.tone]} /><span>{row.name}</span><strong>{row.ratio}%</strong></div>)}</div></aside>
  </div></>;
}

function MemberDetail({ onBack }: { onBack: () => void }) {
  return <><div className={styles.detailBreadcrumb}><button onClick={onBack}><Icon name="chevron-left" size={14} />全团队</button><span>/</span><strong>林小满</strong></div>
    <section className={styles.panel}><div className={styles.detailIdentity}><span className={styles.detailAvatar}>林</span><div><h2>林小满</h2><p>00128 · 员工 · 额度按自然月统计</p></div><span className={styles.status}>正常使用</span></div><div className={styles.quotaStats}><div><span>本月已计</span><strong>¥324.80</strong><small>已结算 ¥264.40</small></div><div><span>月度额度</span><strong>¥500.00</strong><small>当前使用 65%</small></div><div><span>剩余可用</span><strong>¥175.20</strong><small>含预留后的可用金额</small></div><div><span>本月调用</span><strong>68 次</strong><small>3 个模型</small></div></div></section>
    <section className={styles.panel}><Filters /></section><section className={styles.panel}><SectionTitle title="林小满的模型消耗" note="与团队页共用日期、模型和结果筛选" aside="已计 ¥324.80" /><div className={`${styles.analysisGrid} ${styles.stackedAnalysis}`}><div><TrendChart large /></div><div><ModelTable compact /></div></div></section>
    <section className={styles.panel}><SectionTitle title="调用流水" note="仅林小满 · 按时间倒序" /><div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>时间</th><th>模型</th><th>模块</th><th>费用</th></tr></thead><tbody>{calls.map(row => <tr key={row.join()}>{row.map((cell, index) => <td key={cell}>{index === 3 ? moneyLabel(cell) : cell}</td>)}</tr>)}</tbody></table></div></section>
  </>;
}

export default function UsageAnalyticsPrototype() {
  const router = useRouter(); const params = useSearchParams();
  const variant = variants.some(item => item.key === params.get('variant')) ? params.get('variant') as Variant : 'local';
  const [memberOpen, setMemberOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [lastAction, setLastAction] = useState('打开团队用量设计原型');
  const current = variants.find(item => item.key === variant)!;
  const changeVariant = useCallback((next: Variant) => { setMemberOpen(false); setLastAction(`切换到${variants.find(item => item.key === next)?.name}`); router.replace(`/prototype/team/usage-analytics?variant=${next}`, { scroll: false }); }, [router]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = variants.findIndex(item => item.key === variant);
      changeVariant(variants[(index + (event.key === 'ArrowRight' ? 1 : 2)) % variants.length].key);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [variant, changeVariant]);
  useEffect(() => { console.info('[THROWAWAY team usage design]', { variant, memberOpen, lastAction }); }, [variant, memberOpen, lastAction]);

  return <div className={styles.prototype}>
    <header className={styles.prototypeHeader}><span>THROWAWAY · 团队用量设计</span><strong>{current.name}</strong><p>{current.description}</p></header>
    <div className={styles.pageHeading}><div><span className={styles.eyebrow}>USAGE</span><h1>费用与用量</h1><p>团队额度、模型消耗和成员调用，一处看清。</p></div><div className={styles.scope}><button>仅看自己</button><button aria-pressed="true">全团队</button></div></div>
    {memberOpen ? <MemberDetail onBack={() => { setMemberOpen(false); setLastAction('返回全团队'); }} /> : variant === 'local' ? <LocalVariant onOpen={() => { setMemberOpen(true); setLastAction('查看林小满的模型用量'); }} /> : variant === 'trend' ? <TrendVariant onOpen={() => { setMemberOpen(true); setLastAction('查看林小满的模型用量'); }} /> : <MembersVariant onOpen={() => { setMemberOpen(true); setLastAction('查看林小满的模型用量'); }} />}
    <p className={styles.footnote}>所有数字均为设计示例；金额为工作台预估与结算口径，不代表供应商最终账单。本地 Agent 不计入。</p>
    {process.env.NODE_ENV !== 'production' && <aside className={styles.switcher} aria-label="用量设计原型切换">
      <span>设计原型 · 模拟数据</span><div><button aria-label="上一个设计" onClick={() => changeVariant(variants[(variants.findIndex(item => item.key === variant) + 2) % 3].key)}><Icon name="chevron-left" size={15} /></button><strong>{current.name}</strong><button aria-label="下一个设计" onClick={() => changeVariant(variants[(variants.findIndex(item => item.key === variant) + 1) % 3].key)}><Icon name="chevron-right" size={15} /></button></div><button onClick={() => setStateOpen(value => !value)}>查看状态</button>
    </aside>}
    {stateOpen && <div className={styles.stateOverlay} onClick={() => setStateOpen(false)}><section role="dialog" aria-modal="true" aria-label="原型当前状态" onClick={event => event.stopPropagation()}><h2>当前原型状态</h2><p>仅在本页内存中，刷新即重置；没有连接真实数据库。</p><pre>{JSON.stringify({ prototype: true, variant, layout: current.name, memberOpen, lastAction, filters: { period: '本月', model: '全部模型', outcome: '全部结果' }, accountingPeriod: '2026-11', dataSource: 'invented-design-data' }, null, 2)}</pre><button className={styles.refresh} onClick={() => setStateOpen(false)}>关闭</button></section></div>}
  </div>;
}
