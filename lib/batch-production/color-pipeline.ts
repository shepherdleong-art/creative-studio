/**
 * ColorPipeline 模块:统一的色彩处理链定义、校验和 FFmpeg filter 构建。
 *
 * 外部 Interface 接受已冻结且验证过的色彩快照,返回代理、抽帧和未来 renderer
 * 共用的 FFmpeg filter 描述。LUT 路径转义、插值、滤镜顺序、版本和 SDR 约束
 * 只在此 Implementation 中维护。
 */

/** 色彩处理链实现版本;LUT 插值方式、滤镜顺序变化都必须推进这个版本号 */
export const COLOR_PIPELINE_VERSION = 'color-v1';

/** V1 SDR 输出合同版本:标准 SDR 社交视频输出,不涉及 HDR/ACES/专业多级色彩管理 */
export const COLOR_OUTPUT_CONTRACT = 'sdr-v1';

/**
 * 批次版本中每份素材的完整色彩快照。
 *
 * 只有两种状态:
 * - 关闭(lutId === null):各项字段为占位零值
 * - 引用一个已验证 LUT:至少固定 LUT ID、LUT 完整内容指纹、色彩链版本、
 *   lut3d 插值策略和 SDR 输出合同
 *
 * 不再接受只带 lutId 的旧格式——那是不完整的、不可审计的快照。
 */
export interface ColorSnapshotV1 {
  /** 引用的已验证 LUT ID,或 null 表示关闭 */
  lutId: string | null;
  /** LUT 完整内容指纹(sha256:<hex>);lutId === null 时为空字符串 */
  lutFingerprint: string;
  /** 色彩处理链实现版本 */
  colorPipelineVersion: string;
  /** 显式 lut3d 插值策略,不能依赖 FFmpeg 默认值 */
  interpolation: 'trilinear';
  /** V1 SDR 输出合同版本 */
  outputContract: string;
}

/** 默认关闭的色彩快照(只写一个源头,避免各调用方各自拼 JSON 造成漂移) */
export const COLOR_SNAPSHOT_OFF: ColorSnapshotV1 = {
  lutId: null,
  lutFingerprint: '',
  colorPipelineVersion: COLOR_PIPELINE_VERSION,
  interpolation: 'trilinear',
  outputContract: COLOR_OUTPUT_CONTRACT,
};

/**
 * 为一个已验证 LUT 构建完整的色彩快照。
 * lutId 非空时指纹不允许为空:调用方必须传入真实内容指纹(由服务端按
 * 项目内受管 LUT 解析),禁止通过空字符串伪装成"没有指纹"。
 */
export function makeColorSnapshot(lutId: string, lutFingerprint: string): ColorSnapshotV1 {
  if (!lutId || !lutFingerprint || lutFingerprint.startsWith('unresolved:')) {
    throw new Error('色彩快照必须携带非空且可解析的 LUT 内容指纹');
  }
  return {
    lutId,
    lutFingerprint,
    colorPipelineVersion: COLOR_PIPELINE_VERSION,
    interpolation: 'trilinear',
    outputContract: COLOR_OUTPUT_CONTRACT,
  };
}

/**
 * 校验一个色彩快照的结构完整性。
 * 返回 true 表示快照完整(所有必需字段存在且类型正确)。
 * 关闭快照的指纹必须是空字符串;引用 LUT 的快照指纹必须非空且不能是
 * 'unresolved:' 标记——不允许空指纹绕过"引用 LUT 但没锁定内容"的冻结合同。
 */
export function isValidColorSnapshot(value: unknown): value is ColorSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.lutId !== null && obj.lutId !== undefined && typeof obj.lutId !== 'string') return false;
  if (typeof obj.lutFingerprint !== 'string') return false;
  if (obj.colorPipelineVersion !== COLOR_PIPELINE_VERSION) return false;
  if (obj.interpolation !== 'trilinear') return false;
  if (obj.outputContract !== COLOR_OUTPUT_CONTRACT) return false;
  if (obj.lutId === null || obj.lutId === undefined) {
    return obj.lutFingerprint === '';
  }
  return obj.lutFingerprint.length > 0 && !obj.lutFingerprint.startsWith('unresolved:');
}

/**
 * 把一个可能来自旧版本的 JSON 值升级为当代完整的 ColorSnapshotV1。
 * 旧版本只有 { lutId: <string|null> }——补齐缺失字段为兼容默认值。
 * 注意:本函数是纯结构升级,不接触数据库;lutId 非空但拿不到指纹的旧数据
 * 会被标记为 'unresolved:<lutId>'——非空、显式不可用,绝不允许静默降级成
 * 空指纹伪装成关闭状态。真实解析必须由服务端 resolveColorSnapshot 完成。
 */
export function upgradeColorSnapshot(raw: unknown): ColorSnapshotV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return COLOR_SNAPSHOT_OFF;
  }
  const obj = raw as Record<string, unknown>;
  const lutId = (obj.lutId === null || typeof obj.lutId === 'string') ? obj.lutId as string | null : null;
  if (isValidColorSnapshot(obj)) {
    return obj;
  }
  if (lutId === null) {
    return COLOR_SNAPSHOT_OFF;
  }
  const existingFingerprint = typeof obj.lutFingerprint === 'string' && obj.lutFingerprint.length > 0
    ? obj.lutFingerprint
    : `unresolved:${lutId}`;
  return {
    lutId,
    lutFingerprint: existingFingerprint.startsWith('unresolved:') ? existingFingerprint : existingFingerprint,
    colorPipelineVersion: COLOR_PIPELINE_VERSION,
    interpolation: 'trilinear',
    outputContract: COLOR_OUTPUT_CONTRACT,
  };
}

/**
 * 色彩快照的完整身份(用于冻结合同比较和 proxyKey 派生)。
 * 必须包含所有影响颜色的字段,不得只使用 lutId。
 */
export interface ColorSnapshotIdentity {
  lutId: string | null;
  lutFingerprint: string;
  colorPipelineVersion: string;
  interpolation: string;
  outputContract: string;
}

export function colorSnapshotIdentity(snapshot: ColorSnapshotV1): ColorSnapshotIdentity {
  return {
    lutId: snapshot.lutId,
    lutFingerprint: snapshot.lutFingerprint,
    colorPipelineVersion: snapshot.colorPipelineVersion,
    interpolation: snapshot.interpolation,
    outputContract: snapshot.outputContract,
  };
}

/**
 * 转义 FFmpeg filtergraph 参数里的特殊字符。
 * 冒号是选项分隔符、反斜杠是转义符、单引号用于包裹取值——LUT 受管路径
 * 在 Windows 上会带盘符冒号(如 C:\...),必须逐字符转义才能安全传给 -vf。
 */
export function escapeFfmpegFilterPath(absolutePath: string): string {
  return absolutePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

export interface ColorSnapshotFilterInput {
  colorSnapshot: ColorSnapshotV1;
  /** 把 lutId 解析成受管文件的文件系统绝对路径;调用方负责核验内容指纹 */
  resolveLutAbsolutePath: (lutId: string) => string;
}

/**
 * 给定一个已冻结/已验证的色彩快照,返回要拼进 -vf 的 filter 片段(不含前后逗号)。
 * 返回的片段是"完整色彩链":引用 LUT 时先应用显式三线性插值的 lut3d,
 * 然后总是追加 SDR 输出合同片段——显式声明输出为 BT.709 受限范围 SDR,
 * 绝不依赖 FFmpeg 默认值,也绝不允许输出被悄悄标成 HDR/ACES 或任意传递特性。
 * 色彩链版本(COLOR_PIPELINE_VERSION)与 SDR 合同版本(COLOR_OUTPUT_CONTRACT)
 * 一旦变化,这里生成的真实 filter 必须同步变化。
 */
export function buildColorFilterFragments(input: ColorSnapshotFilterInput): string[] {
  const fragments: string[] = [];
  if (input.colorSnapshot.lutId !== null) {
    const absolutePath = input.resolveLutAbsolutePath(input.colorSnapshot.lutId);
    fragments.push(`lut3d='${escapeFfmpegFilterPath(absolutePath)}':interp=trilinear`);
  }
  // SDR 输出合同(sdr-v1):BT.709 primaries/transfer/colorspace + 受限范围。
  // setparams 是真实 filter(元数据契约),不是字符串标签。
  fragments.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  return fragments;
}

/**
 * 构造一个测试帧的 lut3d 验证命令,使用显式三线性插值。
 * 供 LutCatalog 导入验证和独立测试使用。
 */
export function buildLutVerificationArgs(lutAbsolutePath: string): string[] {
  return [
    '-f', 'lavfi', '-i', 'testsrc=duration=0.04:size=32x32:rate=25',
    '-vf', `lut3d='${escapeFfmpegFilterPath(lutAbsolutePath)}':interp=trilinear`,
    '-frames:v', '1', '-y',
  ];
}
