// PROTOTYPE ONLY. Invented people, projects, budgets and metrics, never host facts.
import type { IconName } from '@/components/ui/Icon';

export type ModuleName = '常规项目' | '批量生产' | '详情页脚本' | '创作画布';
export type JobStatus = 'running' | 'queued' | 'done' | 'unknown' | 'paused';
export type Job = { id: string; title: string; project: string; module: ModuleName; owner: string; status: JobStatus; stage: string; progress: number; time: string; pauseNext?: boolean };
export type Project = { id: string; name: string; module: ModuleName; art: number; updated: string; description: string };
export const modules: { name: ModuleName; icon: IconName; text: string; tone: string }[] = [
  { name: '常规项目', icon: 'film', text: '场景、分镜到成片', tone: 'blue' },
  { name: '批量生产', icon: 'grid', text: '多素材，批量出片', tone: 'green' },
  { name: '详情页脚本', icon: 'file-text', text: '读懂产品，写好文案', tone: 'amber' },
  { name: '创作画布', icon: 'sparkle', text: '连接灵感与生成流程', tone: 'violet' },
];
export const initialProjects: Project[] = [
  { id: 'p1', name: '植萃精华 · 秋日上新', module: '常规项目', art: 0, updated: '刚刚编辑', description: '产品场景 / 竖屏短片 / 15 秒' },
  { id: 'p2', name: '随行音箱 · 生活方式', module: '批量生产', art: 1, updated: '18 分钟前', description: '3 组素材 / 6 个版本 / 9:16' },
  { id: 'p3', name: '暖光台灯 · 灵感探索', module: '创作画布', art: 2, updated: '1 小时前', description: '5 个节点 / 3 张场景图' },
];
export const initialJobs: Job[] = [
  { id: 'CS-1102-084', title: '秋日精华 · 15 秒成片', project: '植萃精华 · 秋日上新', module: '常规项目', owner: '林晓', status: 'running', stage: '成片渲染', progress: 68, time: '14:32' },
  { id: 'CS-1102-083', title: '音箱生活方式 · 版本 02', project: '随行音箱 · 生活方式', module: '批量生产', owner: '林晓', status: 'running', stage: '视频生成', progress: 42, time: '14:30' },
  { id: 'CS-1102-082', title: '暖光台灯 · 窗边场景', project: '暖光台灯 · 灵感探索', module: '创作画布', owner: '林晓', status: 'queued', stage: '等待生成名额', progress: 0, time: '14:28' },
  { id: 'CS-1102-081', title: '随行音箱 · 版本 01', project: '随行音箱 · 生活方式', module: '批量生产', owner: '林晓', status: 'done', stage: '成片已交付', progress: 100, time: '14:20' },
  { id: 'CS-1102-080', title: '保温杯 · 城市漫游', project: '保温杯 · 冬季系列', module: '常规项目', owner: '陈可', status: 'unknown', stage: '提交结果待核查', progress: 0, time: '14:18' },
  { id: 'CS-1102-079', title: '家居收纳 · 卖点脚本', project: '家居收纳', module: '详情页脚本', owner: '周宁', status: 'queued', stage: '等待文本名额', progress: 0, time: '14:17' },
  { id: 'CS-1102-078', title: '保温杯 · 细节分镜', project: '保温杯 · 冬季系列', module: '常规项目', owner: '陈可', status: 'running', stage: '分镜生成', progress: 76, time: '14:16' },
];
export const statusNames: Record<JobStatus, string> = { running: '进行中', queued: '排队中', done: '已完成', unknown: '待核查', paused: '已暂停' };
export const clientNav: { key: string; label: string; icon: IconName }[] = [
  { key: 'home', label: '工作台', icon: 'grid' }, { key: 'projects', label: '我的项目', icon: 'folder' },
  { key: 'canvas', label: '创作画布', icon: 'sparkle' }, { key: 'tasks', label: '我的任务', icon: 'logs' },
  { key: 'downloads', label: '下载与交付', icon: 'download' }, { key: 'usage', label: '我的用量', icon: 'table' },
];
export const serverNav: { key: string; label: string; icon: IconName }[] = [
  { key: 'home', label: '运行总览', icon: 'grid' }, { key: 'tasks', label: '全员任务', icon: 'logs' },
  { key: 'resources', label: '模型与并发', icon: 'cpu' }, { key: 'users', label: '成员与账号', icon: 'users' },
  { key: 'library', label: '公共资源', icon: 'folder' }, { key: 'errors', label: '异常中心', icon: 'alert' },
  { key: 'usage', label: '团队用量', icon: 'table' }, { key: 'maintenance', label: '版本与备份', icon: 'settings' },
];
