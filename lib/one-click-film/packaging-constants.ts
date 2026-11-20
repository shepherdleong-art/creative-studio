/**
 * 包装模板的客户端安全常量（纯数据，不 import 任何服务端模块）。
 * 服务端与界面共用同一份 id 与中文名，避免两边各写一套。
 */

export const ONE_CLICK_FILM_TEMPLATE_IDS = [
  'overlay-poster',
  'overlay-journal',
  'overlay-minimal',
  'overlay-variety',
] as const;

export type OneClickFilmTemplateId = (typeof ONE_CLICK_FILM_TEMPLATE_IDS)[number];

export const ONE_CLICK_FILM_TEMPLATE_LABELS: Record<OneClickFilmTemplateId, string> = {
  'overlay-poster': '花字种草',
  'overlay-journal': '手账拼贴',
  'overlay-minimal': '极简高级',
  'overlay-variety': '综艺撕纸',
};

export function isOneClickFilmTemplate(value: unknown): value is OneClickFilmTemplateId {
  return typeof value === 'string' && (ONE_CLICK_FILM_TEMPLATE_IDS as readonly string[]).includes(value);
}
