// interpret.js — 把数值指标翻译成中文听感描述（状态药丸 + 摘要卡片）
//
// 明暗（音色亮度）的声学依据（钉死的模型，非经验拍脑袋）：
//   亮度 ↔ 频谱质心 / 频谱倾斜。频谱重心越偏高频、谱斜越平缓 → 听感越明亮。
//   声门源的典型谐波衰减约 −12 dB/oct；声门闭合越强 → 高次谐波越多 → 谱斜越平 → 越亮。
//   因此本应用用「频谱倾斜 tilt(dB/oct)」驱动明暗：tilt 越接近 0（越平）越亮，越负（越陡）越暗。
//   面向 MtF/FtM 训练：更明亮（更高质心/更平谱斜/更高共振）= 女性化方向，反之男性化方向。
//   参考：
//     - Schubert & Wolfe (2006), "Does Timbral Brightness Scale with Frequency and Spectral Centroid?"
//     - McAdams (2019), "The Perceptual Representation of Timbre"（质心=亮度的主轴）
//     - Hanson (1997)/Klatt&Klatt (1990)：H1–H2 ↔ 气声/声门开商（与明暗相互独立）
//     - 跨性别嗓音综述：F0、共振峰、频谱重心(CoG) 与女性化感知正相关
//
// 注：早期版本用「低/高平衡(high−low)」判明暗是错的——人声该值几乎恒为负，导致"明亮"永不触发。
// H1–H2 的阈值为气声/压声经验值，可调；明暗的方向与锚点(−12 dB/oct)是上面的声学事实。

const fmtDb = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
const fmtTilt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB/oct.`;

/** 顶部状态药丸文案，例如「更显气声且低沉」。 */
export function pillText(m) {
  // 气声/压声：放宽中性带，匹配原版（H1-H2≈-0.7 视为"中间"而非压声）
  let breath;
  if (m.h1h2 > 8) breath = '更显气声';
  else if (m.h1h2 < -2) breath = '更显压声';
  else breath = '气压均衡';

  // 明暗 = 频谱倾斜（见文件顶部声学依据）：越平缓越亮，越陡越暗。锚点 −12 dB/oct。
  let tone;
  if (m.tilt > -8) tone = '明亮';
  else if (m.tilt < -16) tone = '低沉';
  else tone = '中性音色';

  if (breath === '气压均衡' && tone === '中性音色') return '气声与音色均衡';
  return `${breath}且${tone}`;
}

/** 三张摘要卡片的内容（标题随指标变化，说明文字固定）。 */
export function summaryCards(m) {
  // —— 卡片一：气声 / 压声（中性带放宽以匹配原版） —— //
  let breathHeading;
  if (m.h1h2 > 8) breathHeading = 'H1–H2 表示更带气音的发声模式';
  else if (m.h1h2 < -2) breathHeading = 'H1–H2 表示更紧绷的发声模式';
  else breathHeading = 'H1–H2 位于中间位置';

  // —— 卡片二：更暗 / 更亮（由频谱倾斜驱动，见文件顶部声学依据） —— //
  let brightHeading;
  if (m.tilt > -8) brightHeading = '高频谐波保留充分，听感更明亮';
  else if (m.tilt < -16) brightHeading = '高频衰减快，能量集中低频，听感更暗';
  else brightHeading = '高频衰减适中，明暗居中';

  // —— 卡片三：频谱倾斜 —— //
  let tiltHeading;
  if (m.tilt < -9) tiltHeading = 'H1–H5 频段内负向倾斜度更大';
  else if (m.tilt > -3) tiltHeading = 'H1–H5 频段内倾斜平缓，高频保留更多';
  else tiltHeading = 'H1–H5 频段内倾斜适中';

  return [
    {
      eyebrow: '气声 / 压声',
      heading: breathHeading,
      values: [`H1-H2：${fmtDb(m.h1h2)}`],
      desc: 'H1 和 H2 之间的区别通常与气声有关，间隙越大通常气声越重；间隙越小则声音越紧绷。',
    },
    {
      eyebrow: '更暗 / 更亮',
      heading: brightHeading,
      values: [`H1-H5：${fmtDb(m.h1h5)}`, `低频/高频平衡 ${fmtDb(m.lowHigh)}`],
      desc: '这取决于 H1 到 H5 的衰减速率以及低频谐波与高频谐波之间的平衡。衰减速率越快，听感通常越暗沉；而高频谐波越强，听感通常越明亮。',
    },
    {
      eyebrow: '频谱倾斜',
      heading: tiltHeading,
      values: [`H1-H5：${fmtTilt(m.tilt)}`],
      desc: '频谱倾斜度是指 H1 至 H5 频段的整体斜率。负斜率越陡，高次谐波衰减越快，听起来往往更柔和或更暗沉；斜率越平缓，高次谐波的保留程度就越强。',
    },
  ];
}

/**
 * 把指标映射到特征垫坐标（均为 0~1）：
 *   padX  横轴 0=更深色（左）→ 1=更明亮（右），由低/高平衡驱动
 *   padY  纵轴 0=已按压（上）→ 1=更轻柔（下），由 H1-H2 气声量驱动
 */
export function metricsToPad(m) {
  const clamp = (v) => Math.max(0.06, Math.min(0.94, v));
  // 横轴明暗由频谱倾斜驱动：以声门基线 −12 dB/oct 为正中，越平缓→越明亮(右)，越陡→越暗(左)。
  const padX = clamp(0.5 + (m.tilt + 12) / 15);
  const padY = clamp(0.5 + m.h1h2 / 40);
  return { padX, padY };
}
