/** 设备分组色（2026-09-28 用户裁决：Chrome 标签组式颜色气泡，强化多设备分组辨识）。
 *  同色 = 同设备：设备卡左条、图标芯片、服务网格图标、服务树抽屉头共用一色。
 *  颜色由 deviceId 稳定散列——重连/清缓存/换浏览器后同一设备恒同色。
 *  8 色板避开状态语义色冲突：琥珀留给 stall/探活告警、红留给故障，分组色只作身份标识。 */
export interface GroupColor {
  /** 主色：左条/图标底/抽屉头圆点。 */
  fg: string;
  /** 柔色底：图标芯片、选中行、卡片头部的衬底。 */
  soft: string;
}

export const GROUP_PALETTE: GroupColor[] = [
  { fg: '#2563EB', soft: '#E7EEFD' }, // 蓝
  { fg: '#0A8A5F', soft: '#E3F3EC' }, // 品牌绿
  { fg: '#7C3AED', soft: '#F0E9FD' }, // 紫
  { fg: '#0891B2', soft: '#E2F5F9' }, // 青
  { fg: '#DB2777', soft: '#FCE8F2' }, // 品红
  { fg: '#0D9488', soft: '#E2F5F3' }, // 蓝绿
  { fg: '#65A30D', soft: '#EFF6E0' }, // 青柠
  { fg: '#9333EA', soft: '#F3E8FD' }, // 亮紫
];

/** djb2 散列 → 色板下标。空串/未知设备落到品牌绿（下标 1），与「默认即自家色」一致。 */
export function deviceColor(deviceId: string): GroupColor {
  let h = 5381;
  for (let i = 0; i < deviceId.length; i++) h = ((h << 5) + h + deviceId.charCodeAt(i)) >>> 0;
  return GROUP_PALETTE[deviceId ? h % GROUP_PALETTE.length : 1];
}
