/**
 * 外部（非公司）供应商的画布能力表。
 *
 * **只注册真正可用的行**：数据库里存在、已启用、且已配置 API Key 的供应商才会出现在画布模型列表里。
 * 协议支持范围与仓库既有适配器一致，未支持的组合不注册（界面不开放提交必然失败的模型）。
 * 证据层级固定为 mapped（本地请求映射已验证），真实样例由 P7 样本补齐后才谈 verified。
 */

import type Database from 'better-sqlite3';
import type { CanvasModelCapability } from '../capabilities.ts';

interface ExternalModelSpec {
  providerId: string;
  table: 'providers' | 'video_providers';
  capability: CanvasModelCapability;
}

const EXTERNAL_MODEL_SPECS: ReadonlyArray<ExternalModelSpec> = [
  {
    providerId: 'packy-gpt-image-2',
    table: 'providers',
    capability: {
      key: 'external-packy-gpt-image-2',
      displayName: 'Packy GPT-Image-2',
      providerKind: 'external',
      providerIdentity: 'packy-gpt-image-2',
      modelAlias: 'gpt-image-2',
      mediaKind: 'image',
      modes: ['text-to-image', 'image-to-image'],
      inputs: [
        // 图1 = 待编辑底图，其后按节点顺序是参考图（不做自动提示词前缀）
        { kind: 'image', roles: ['subject', 'product', 'style', 'scene', 'reference'], min: 0, max: 6 },
        { kind: 'text', roles: ['reference'], min: 0, max: 1 },
      ],
      parameters: [
        { key: 'aspectRatio', label: '比例', type: 'enum', options: ['1:1', '3:4', '4:3', '16:9', '9:16'], default: '1:1' },
        { key: 'resolution', label: '清晰度', type: 'enum', options: ['1K', '2K', '4K'], default: '1K' },
      ],
      cancellation: false,
      evidence: 'verified',
      evidenceNote: '真实链路样例：R01 文生图（1728×2304 PNG）、R02 图生图＋双参考（864×1152 PNG），均经画布链路真实提交并归档到 outputs/canvas-validation/p7。4K 档位与 6 张以上参考图的组合未跑过，仍属文档依据。',
    },
  },
  {
    providerId: 'jimeng-2-0',
    table: 'video_providers',
    capability: {
      key: 'external-jimeng-seedance-2-0',
      displayName: '即梦 Seedance 2.0（直连方舟）',
      providerKind: 'external',
      providerIdentity: 'jimeng-2-0',
      modelAlias: 'doubao-seedance-2-0-260128',
      mediaKind: 'video',
      // 文生视频走适配器的显式文本合同（content 只有文本项）；图生视频带可选尾帧；
      // 视频生视频／参考生成走多模态参考合同（reference_image / reference_video / reference_audio）。
      modes: ['text-to-video', 'image-to-video', 'video-to-video', 'reference-to-video'],
      inputs: [
        // 首帧：1 张图（角色可以是默认的「主体」，单图必然是首帧）；
        // 首尾帧：两张图，其中一张必须显式标为尾帧（方舟要求两张都写角色），由适配器校验
        {
          kind: 'image',
          roles: ['first-frame', 'last-frame', 'subject', 'reference'],
          min: 1,
          max: 2,
          modes: ['image-to-video'],
        },
        // 多模态参考（方舟规则：首帧、严格首尾帧、多模态参考三种图片模式互斥；2.0 系列 0–9 图 + 0–3 视频 + 0–3 音频）。
        // 画布把多模态参考拆成两个入口：参考生成要求至少 1 张参考图，视频生视频要求至少 1 段参考视频；
        // 两者都允许混搭，音频必须与图或视频同时出现（两个入口的 min 都保证了这一点）。
        { kind: 'image', roles: ['reference', 'subject', 'product', 'style', 'scene'], min: 1, max: 9, modes: ['reference-to-video'] },
        { kind: 'video', roles: ['reference', 'camera'], min: 0, max: 3, modes: ['reference-to-video'] },
        { kind: 'image', roles: ['reference', 'subject', 'product', 'style', 'scene'], min: 0, max: 9, modes: ['video-to-video'] },
        { kind: 'video', roles: ['reference', 'camera'], min: 1, max: 3, modes: ['video-to-video'] },
        {
          kind: 'audio',
          roles: ['audio'],
          min: 0,
          max: 3,
          modes: ['reference-to-video', 'video-to-video'],
          // 方舟只接受 WAV／MP3；交付层默认还放行 audio/mp4，这里收紧
          mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav'],
        },
        { kind: 'text', roles: ['reference'], min: 0, max: 1 },
      ],
      parameters: [
        { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 4, max: 15, default: 5 },
        // 参考模式没有首帧可吸附，比例必须显式给
        {
          key: 'aspectRatio',
          label: '比例',
          type: 'enum',
          options: ['16:9', '9:16', '1:1', '4:3', '3:4'],
          default: '16:9',
          modes: ['text-to-video', 'video-to-video', 'reference-to-video'],
        },
      ],
      cancellation: false,
      evidence: 'verified',
      evidenceNote:
        '真实链路样例：R03 文生视频、R04 图生视频（首帧）、R09 首尾帧（产物起点≈首帧色 #c3b498、终点≈尾帧色 #d8e4e6，证明 last_frame 角色生效）、'
        + 'R07 视频生视频（一次请求同时带 reference_video／reference_image／reference_audio）、R08 参考生成（双参考图）。'
        + '未跑到的边界仍属文档依据：9 图／3 视频／3 音频的**上限**、4–15 秒全区间、480p 与 4k 档位。'
        + '参考视频／音频必须经 COS 交付，本机地址不接受。',
    },
  },
];

/** 只有「行存在 + 已启用 + 已配置 Key」的外部模型才注册，避免开放提交必然失败的入口。 */
export function registerExternalCanvasCapabilities(
  db: Database.Database,
  register: (capability: CanvasModelCapability) => unknown,
): string[] {
  const registered: string[] = [];
  for (const spec of EXTERNAL_MODEL_SPECS) {
    try {
      const row = spec.table === 'providers'
        ? db.prepare(`SELECT enabled, apiKey FROM providers WHERE id = ?`).get(spec.providerId)
        : db.prepare(`SELECT enabled, apiKey FROM video_providers WHERE id = ?`).get(spec.providerId);
      const typed = row as { enabled?: number; apiKey?: string } | undefined;
      if (!typed || Number(typed.enabled) !== 1 || !String(typed.apiKey ?? '').trim()) continue;
      register(spec.capability);
      registered.push(spec.capability.key);
    } catch {
      // 供应商表缺失或读取失败时不注册，也不影响画布其它能力
    }
  }
  return registered;
}
