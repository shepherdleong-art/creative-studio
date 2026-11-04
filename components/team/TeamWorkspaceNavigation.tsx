'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { HeaderPrincipal } from '@/components/Header';
import s from './workspace.module.css';

export default function TeamWorkspaceNavigation({ principal, canvasEnabled }: { principal: HeaderPrincipal; canvasEnabled: boolean }) {
  const pathname = usePathname();
  const admin = principal.role === 'admin';
  const links: Array<{ href: string; label: string; icon: IconName }> = [
    { href: '/', label: admin ? '运行总览' : '工作台', icon: 'grid' },
    { href: '/projects', label: admin ? '项目空间' : '我的项目', icon: 'folder' },
    ...(canvasEnabled ? [{ href: '/canvas', label: '创作画布', icon: 'sparkle' as const }] : []),
    { href: '/team/tasks', label: admin ? '全员任务' : '我的任务', icon: 'logs' },
    { href: '/team/downloads', label: '下载与交付', icon: 'download' },
    ...(admin ? [
      { href: '/team/admin/pools', label: '模型与并发', icon: 'cpu' as const },
      { href: '/settings', label: '供应商配置', icon: 'settings' as const },
      { href: '/team/admin/users', label: '成员与账号', icon: 'users' as const },
      { href: '/team/admin/resources', label: '公共资源', icon: 'folder' as const },
    ] : []),
    { href: '/team/errors', label: '异常中心', icon: 'alert' },
    { href: '/usage', label: admin ? '团队用量' : '我的用量', icon: 'table' },
    { href: '/team/recycle-bin', label: '回收站', icon: 'trash' },
    { href: '/team/account', label: '修改密码', icon: 'key' },
    ...(admin ? [{ href: '/team/admin/operations', label: '版本与备份', icon: 'monitor' as const }] : []),
  ];
  return <aside className={s.sidebar} aria-label="工作台侧栏">
    <Link href="/" className={s.brand}><span className={s.brandMark}><Icon name="sparkle" size={22}/></span><span>Creative Studio<small>产品素材工作台</small></span></Link>
    <p className={s.navCaption}>{admin ? '团队管理空间' : '我的创作空间'}</p>
    <nav aria-label={admin ? '团队管理导航' : '创作导航'}>{links.map(link => <Link key={link.href} href={link.href} title={link.label} aria-label={link.label} aria-current={(pathname === link.href || (link.href !== '/' && pathname.startsWith(`${link.href}/`))) ? 'page' : undefined}><Icon name={link.icon} size={18}/><span>{link.label}</span></Link>)}</nav>
    <div className={s.sideBottom}><span className={s.avatar}>{principal.displayName.slice(0, 1)}</span><div><strong>{principal.displayName}</strong><small>{principal.employeeId} · {admin ? '管理员' : '创作成员'}</small></div></div>
    <p className={s.sideHint}>关闭窗口不会中断服务器任务</p>
  </aside>;
}
