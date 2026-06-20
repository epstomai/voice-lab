// render.js — 在单个 Canvas 上绘制谐波柱状图与二维特征垫
//
// 把柱状图和特征垫放在同一画布，是为了让那条粉色包络曲线能够从 H1 一路
// 流向右侧特征垫上的数据点——视觉上把“频谱形态”与“嗓音坐标”连成一体。

// 每个谐波的配色：粉 → 紫 → 蓝 的连续色阶（呼应跨性别旗帜，深底上鲜亮）
export const HARMONIC_COLORS = [
  { top: '#f48fb1', bottom: '#f9bcd0', bubble: '#f06a9c' }, // H1 粉
  { top: '#d98fcf', bottom: '#ecbbe2', bubble: '#cf6cc4' }, // H2 粉紫
  { top: '#9d9ce2', bottom: '#c6c5f0', bubble: '#7f7ee0' }, // H3 紫（过渡）
  { top: '#6cb6f0', bottom: '#a9d6f7', bubble: '#46a8ed' }, // H4 蓝
  { top: '#4ec6f7', bottom: '#8edcfb', bubble: '#26baf2' }, // H5 天蓝
];

const AXIS_COLOR = 'rgba(233, 238, 247, 0.55)';
const GRID_COLOR = 'rgba(255, 255, 255, 0.10)';
const DASH_CURVE = 'rgba(255, 255, 255, 0.28)';
const PINK_CURVE = '#f4a3c0';
const MAX_LEVEL = 80; // y 轴上限

/** 计算各区域的几何布局（基于 CSS 像素的逻辑坐标）。 */
export function computeLayout(width, height) {
  const padL = 56;   // 左侧让出 y 轴刻度
  const padR = 16;
  const padT = 48;   // 顶部留白：容纳满刻度柱子上方的数值气泡，避免被裁切
  const padB = 54;   // 底部让出 H1..H5 标签

  const plotTop = padT;
  const plotBottom = height - padB;
  const baseY = plotBottom;

  // 左侧柱状图区 ~ 54%，右侧特征垫 ~ 40%，中间留间隙
  const chartLeft = padL;
  const chartRight = padL + (width - padL - padR) * 0.52;
  const padLeft = chartRight + (width - padL - padR) * 0.06;
  const padRight = width - padR;

  return {
    width, height,
    plotTop, plotBottom, baseY,
    chart: { left: chartLeft, right: chartRight },
    pad: { left: padLeft, right: padRight, top: plotTop + 6, bottom: baseY },
  };
}

function levelToY(level, layout) {
  const t = Math.max(0, Math.min(1, level / MAX_LEVEL));
  return layout.baseY - t * (layout.baseY - layout.plotTop);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 经过给定点的 Catmull-Rom 平滑曲线（转 bezier）
function smoothCurve(ctx, pts) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

/**
 * 主绘制入口。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout    computeLayout 的结果
 * @param {object} state     { levels[5], baseline[5], padX, padY, active }
 */
export function draw(ctx, layout, state) {
  const { width, height } = layout;
  ctx.clearRect(0, 0, width, height);

  drawGrid(ctx, layout);
  drawPad(ctx, layout, state);
  const barTops = drawBars(ctx, layout, state);
  drawBaselineCurve(ctx, layout, state);
  drawLiveCurve(ctx, layout, state, barTops);
  drawBars2ndPass(ctx, layout, state, barTops); // 数值气泡画在曲线之上
}

function drawGrid(ctx, layout) {
  ctx.save();
  ctx.font = '600 15px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = AXIS_COLOR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [20, 40, 60, 80]) {
    const y = levelToY(v, layout);
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.chart.left - 8, y);
    ctx.lineTo(layout.chart.right, y);
    ctx.stroke();
    ctx.fillText(String(v), layout.chart.left - 14, y);
  }
  // 基线
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(layout.chart.left - 8, layout.baseY);
  ctx.lineTo(layout.chart.right, layout.baseY);
  ctx.stroke();
  ctx.restore();
}

function barGeometry(layout, i) {
  const { left, right } = layout.chart;
  const slot = (right - left) / 5;
  const barW = Math.min(46, slot * 0.62);
  const cx = left + slot * (i + 0.5);
  return { cx, barW, slot };
}

function drawBars(ctx, layout, state) {
  const tops = [];
  for (let i = 0; i < 5; i++) {
    const { cx, barW } = barGeometry(layout, i);
    const level = state.levels[i];
    const topY = levelToY(level, layout);
    const x = cx - barW / 2;
    const h = layout.baseY - topY;
    tops.push({ x: cx, y: topY });

    if (h > 1) {
      const grad = ctx.createLinearGradient(0, topY, 0, layout.baseY);
      grad.addColorStop(0, HARMONIC_COLORS[i].top);
      grad.addColorStop(1, HARMONIC_COLORS[i].bottom);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = grad;
      roundRectPath(ctx, x, topY, barW, h, barW / 2);
      ctx.fill();
      ctx.restore();
    }

    // x 轴标签 H1..H5
    ctx.save();
    ctx.font = '700 21px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(233, 238, 247, 0.82)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('H' + (i + 1), cx, layout.baseY + 12);
    ctx.restore();
  }
  return tops;
}

// 数值气泡（在曲线之后绘制，保证可读性）
function drawBars2ndPass(ctx, layout, state, tops) {
  if (state.hasData === false) return; // 空状态不显示数值气泡
  for (let i = 0; i < 5; i++) {
    const { y } = tops[i];
    const { cx } = barGeometry(layout, i);
    const r = 21;
    const by = Math.max(r + 2, y - r - 4); // 不越过画布顶部，保证数字始终可见
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = HARMONIC_COLORS[i].bubble;
    ctx.beginPath();
    ctx.arc(cx, by, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 19px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(state.levels[i])), cx, by + 1);
    ctx.restore();
  }
}

function drawBaselineCurve(ctx, layout, state) {
  if (state.hasData === false) return; // 空状态不画参考基线
  if (!state.baseline) return;
  const pts = state.baseline.map((lvl, i) => ({
    x: barGeometry(layout, i).cx,
    y: levelToY(lvl, layout),
  }));
  ctx.save();
  ctx.strokeStyle = DASH_CURVE;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  smoothCurve(ctx, pts);
  ctx.stroke();
  ctx.restore();
}

function drawLiveCurve(ctx, layout, state, tops) {
  if (state.hasData === false) return; // 空状态不画包络曲线
  // 实时包络：H1..H5 的柱顶，再延伸到特征垫上的数据点
  const dot = padDotPos(layout, state);
  const pts = tops.map((p) => ({ x: p.x, y: p.y }));
  pts.push({ x: dot.x, y: dot.y });

  ctx.save();
  ctx.strokeStyle = PINK_CURVE;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(244, 163, 192, 0.45)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  smoothCurve(ctx, pts);
  ctx.stroke();
  ctx.restore();
}

function padDotPos(layout, state) {
  const { left, right, top, bottom } = layout.pad;
  // 内缩，避免数据点贴边
  const ix = left + 24, iw = right - left - 48;
  const iy = top + 24, ih = bottom - top - 48;
  return {
    x: ix + Math.max(0, Math.min(1, state.padX)) * iw,
    y: iy + Math.max(0, Math.min(1, state.padY)) * ih,
  };
}

function drawPad(ctx, layout, state) {
  const { left, right, top, bottom } = layout.pad;
  const w = right - left, h = bottom - top;

  // 背景：暗色面板，左下偏蓝(暗) → 右上偏粉(亮) 的微妙方向感
  const grad = ctx.createLinearGradient(left, bottom, right, top);
  grad.addColorStop(0, '#101a30');
  grad.addColorStop(1, '#181530');
  ctx.save();
  roundRectPath(ctx, left, top, w, h, 22);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.clip();
  // 右上淡粉辉光，提示「更明亮」一侧
  const tint = ctx.createLinearGradient(left, bottom, right, top);
  tint.addColorStop(0, 'rgba(91, 206, 250, 0.05)');
  tint.addColorStop(1, 'rgba(245, 169, 196, 0.12)');
  ctx.fillStyle = tint;
  ctx.fillRect(left, top, w, h);

  // 虚线十字
  const cx = left + w / 2, cy = top + h / 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(cx, top + 14); ctx.lineTo(cx, bottom - 14);
  ctx.moveTo(left + 14, cy); ctx.lineTo(right - 14, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  // 四向标签
  ctx.fillStyle = 'rgba(233, 238, 247, 0.72)';
  ctx.font = '600 19px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('已按压', cx, top + 16);
  ctx.textBaseline = 'bottom';
  ctx.fillText('更轻柔', cx, bottom - 14);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('更深色', left + 18, cy);
  ctx.textAlign = 'right';
  ctx.fillText('更明亮', right - 18, cy);
  ctx.restore();

  // 数据点：粉色光晕 + 红心 + 白环
  const dot = padDotPos(layout, state);
  const alpha = state.active ? 1 : 0.4;
  ctx.save();
  const halo = ctx.createRadialGradient(dot.x, dot.y, 2, dot.x, dot.y, 34);
  halo.addColorStop(0, `rgba(240, 106, 160, ${0.4 * alpha})`);
  halo.addColorStop(1, 'rgba(240, 106, 160, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 13, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgba(240, 106, 160, ${alpha})`;
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const PITCH_COLOR = '#5bcefa';

/**
 * 基频实时曲线（音高轨迹）。独立画布。
 * @param {object} samples  [{t, f0}]，f0=0 表示该帧无声（曲线断开）
 * @param {object} opt      { lo, hi, now, windowMs, hasData, showTarget, targetHz }
 */
const TARGET_COLOR = '#f5a9c4';
const TARGET_LABEL = '#f7bcd0';
const MEAN_COLOR = '#e6ecf5';

export function drawPitchTrack(ctx, w, h, samples, opt) {
  ctx.clearRect(0, 0, w, h);
  const padL = 46, padR = 16, padT = 14, padB = 10;
  const left = padL, right = w - padR, top = padT, bottom = h - padB;
  const { lo, hi, now, windowMs, hasData, showTarget, targetHz, meanHz } = opt;
  const span = Math.max(1, hi - lo);
  const yOfHz = (v) => bottom - ((v - lo) / span) * (bottom - top);

  // 上下两条灰色刻度线（lo / hi）
  ctx.save();
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(233, 238, 247, 0.5)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [lo, hi]) {
    const y = yOfHz(v);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(Math.round(v) + '', left - 8, y);
  }

  // 中线：开启目标线 → 画固定的目标频率线（醒目橙色虚线）；否则画自动中线（灰）
  if (showTarget && targetHz >= lo && targetHz <= hi) {
    const y = yOfHz(targetHz);
    ctx.strokeStyle = TARGET_COLOR;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = TARGET_LABEL;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(targetHz) + '', left - 8, y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('目标', left + 4, y - 3);
    ctx.textBaseline = 'middle';
  } else if (!showTarget) {
    const v = (lo + hi) / 2;
    const y = yOfHz(v);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(Math.round(v) + '', left - 8, y);
  }

  ctx.restore();

  if (!hasData) {
    ctx.save();
    ctx.fillStyle = 'rgba(233, 238, 247, 0.45)';
    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('等待发声…', (left + right) / 2, (top + bottom) / 2);
    ctx.restore();
    return;
  }

  const t0 = now - windowMs;
  const xOf = (t) => left + ((t - t0) / windowMs) * (right - left);
  const yOf = (f) => bottom - ((Math.max(lo, Math.min(hi, f)) - lo) / span) * (bottom - top);

  // 折线：跳过窗外与静音点但不断笔，让曲线保持连续完整
  ctx.save();
  ctx.strokeStyle = PITCH_COLOR;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  let last = null;
  for (const s of samples) {
    if (s.t < t0 || s.f0 <= 0) continue;
    const x = xOf(s.t), y = yOf(s.f0);
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    last = s;
  }
  ctx.stroke();
  ctx.restore();

  // 当前点 + Hz 数值气泡（图内直接显示基频）
  if (last) {
    const x = xOf(last.t), y = yOf(last.f0);
    ctx.save();
    ctx.fillStyle = PITCH_COLOR;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const label = Math.round(last.f0) + ' Hz';
    ctx.font = '700 15px "Segoe UI", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 18, bh = 24;
    let bx = x - bw - 10;                 // 默认放当前点左侧（点通常贴右边缘）
    if (bx < left + 2) bx = x + 10;       // 空间不足则放右侧
    let by = Math.max(top + 2, Math.min(bottom - bh - 2, y - bh / 2));
    roundRectPath(ctx, bx, by, bw, bh, 12);
    ctx.fillStyle = PITCH_COLOR;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
    ctx.restore();
  }

  // 3 秒均值线 + 标签：最后绘制（置于曲线之上，不被实时频率遮挡）；
  // 标签靠左加深底，避开右端的当前频率气泡。
  if (meanHz && meanHz >= lo && meanHz <= hi) {
    const y = yOfHz(meanHz);
    ctx.save();
    ctx.strokeStyle = MEAN_COLOR;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    const mlabel = '3秒均值 ' + Math.round(meanHz);
    const tw = ctx.measureText(mlabel).width;
    const bw = tw + 12, bh = 18;
    const bx = left + 2;
    let by = y - bh - 3;
    if (by < top) by = y + 3; // 顶部空间不足则放到线下方
    roundRectPath(ctx, bx, by, bw, bh, 6);
    ctx.fillStyle = 'rgba(11, 18, 32, 0.7)';
    ctx.fill();
    ctx.fillStyle = MEAN_COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(mlabel, bx + 6, by + bh / 2 + 0.5);
    ctx.restore();
  }
}

// ———————————————————————————————————————————————
// 共鸣空间图：横轴 F2、纵轴 F1，标出当前共鸣点、移动拖尾、典型男声元音锚点、偏男/偏女方向区
// ———————————————————————————————————————————————
const F2_MIN = 700, F2_MAX = 2900, F1_MIN = 250, F1_MAX = 1050;
// 典型成人男声元音共振峰（Hz），作为定位锚点
const VOWEL_ANCHORS = [
  ['i 衣', 2300, 270], ['e 诶', 1840, 530], ['a 啊', 1090, 730],
  ['o 哦', 840, 570], ['u 乌', 870, 300],
];

export function drawResonanceMap(ctx, w, h, st) {
  ctx.clearRect(0, 0, w, h);
  // 左右对称内边距 → 绘图区水平居中；底部略大留给 F2 轴标题
  const padL = 18, padR = 18, padT = 16, padB = 30;
  const left = padL, right = w - padR, top = padT, bottom = h - padB;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const xOf = (f2) => left + ((clamp(f2, F2_MIN, F2_MAX) - F2_MIN) / (F2_MAX - F2_MIN)) * (right - left);
  const yOf = (f1) => bottom - ((clamp(f1, F1_MIN, F1_MAX) - F1_MIN) / (F1_MAX - F1_MIN)) * (bottom - top);

  // 底 + 对角方向渐变（左下偏男蓝 → 右上偏女粉）
  ctx.save();
  roundRectPath(ctx, left, top, right - left, bottom - top, 14);
  ctx.fillStyle = '#0f1830';
  ctx.fill();
  ctx.clip();
  const g = ctx.createLinearGradient(left, bottom, right, top);
  g.addColorStop(0, 'rgba(91, 206, 250, 0.16)');
  g.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  g.addColorStop(1, 'rgba(245, 169, 196, 0.20)');
  ctx.fillStyle = g;
  ctx.fillRect(left, top, right - left, bottom - top);

  // —— 偏男 / 中性 / 偏女 区域分界（与录音报告判别一致：s = 0.5·F2norm + 0.5·F1norm） —— //
  // 等权下边界 s=c 是反对角线 xn+yn=2c，端点 (0,2c) 与 (2c,0)。c=0.38/0.44 由 Hillenbrand 校准。
  const Xn = (xn) => left + xn * (right - left);
  const Yn = (yn) => bottom - yn * (bottom - top);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 5]);
  for (const c of [0.38, 0.44]) {
    ctx.beginPath();
    ctx.moveTo(Xn(0), Yn(2 * c));
    ctx.lineTo(Xn(2 * c), Yn(0));
    ctx.stroke();
  }
  ctx.restore();

  // 区域标签
  ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f5a9c4';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText('偏女', right - 10, top + 8);
  ctx.fillStyle = '#5bcefa';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('偏男', left + 10, bottom - 8);
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(233, 238, 247, 0.62)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('中性', Xn(0.5), Yn(0.32));
  ctx.restore();

  // 边框
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, left, top, right - left, bottom - top, 14);
  ctx.stroke();

  // 典型男声元音锚点（浅灰）
  ctx.fillStyle = 'rgba(233, 238, 247, 0.55)';
  ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
  for (const [name, f2, f1] of VOWEL_ANCHORS) {
    const x = xOf(f2), y = yOf(f1);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x + 6, y);
  }
  ctx.restore();

  // 轴标题
  ctx.save();
  ctx.fillStyle = 'rgba(233, 238, 247, 0.5)';
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('F2 →（舌位靠前 · 共鸣更亮）', (left + right) / 2, h - 8);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('F1 ↑ 口腔更开', left + 2, 2);
  ctx.restore();

  if (!st.hasData) {
    ctx.save();
    ctx.fillStyle = 'rgba(233, 238, 247, 0.45)';
    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('等待发声…', (left + right) / 2, (top + bottom) / 2);
    ctx.restore();
    return;
  }

  // 移动拖尾（旧淡新浓）
  const trail = st.trail || [];
  if (trail.length > 1) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      if (!(a.f1 && a.f2 && b.f1 && b.f2)) continue;
      ctx.strokeStyle = `rgba(240, 106, 160, ${0.08 + 0.5 * (i / trail.length)})`;
      ctx.beginPath();
      ctx.moveTo(xOf(a.f2), yOf(a.f1));
      ctx.lineTo(xOf(b.f2), yOf(b.f1));
      ctx.stroke();
    }
    ctx.restore();
  }

  // 当前共鸣点
  if (st.f1 && st.f2) {
    const x = xOf(st.f2), y = yOf(st.f1);
    const alpha = st.active ? 1 : 0.45;
    ctx.save();
    const halo = ctx.createRadialGradient(x, y, 2, x, y, 22);
    halo.addColorStop(0, `rgba(240, 106, 160, ${0.32 * alpha})`);
    halo.addColorStop(1, 'rgba(240, 106, 160, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(240, 106, 160, ${alpha})`;
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
