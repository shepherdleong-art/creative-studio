/** 实拍混剪开关：默认关闭。关闭时不建表、不起后台任务、接口一律返回不可用。 */
export function liveMixcutFeatureEnabled(): boolean {
  return process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE === '1';
}
