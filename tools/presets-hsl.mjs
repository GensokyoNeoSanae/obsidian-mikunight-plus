// 预设配色的 HSL 三元组 → 实际 hex + 与背景 / 正文的对比度。
// 这张表必须和插件 main.js 里的 PRESETS 保持一致 —— 改完预设跑一遍核对。
// 顺序也跟着 main.js，方便两边逐行对照。
//
// 各套的 s / l 是按色相补偿过的：HSL 里同一个 l 在不同色相上的感知亮度差很大
// （相对亮度权重 R 0.2126 / G 0.7152 / B 0.0722），所以要拉齐「跳眼程度」，
// 绿 / 黄绿得压低亮度，蓝 / 紫 / 粉要抬高亮度。
//
// 注意 Akari（香槟白）是有意例外的：它的 s 只有 18%，跟正文色 #F0F0F0 的
// 亮度对比度只有 1.17，比别的套低一大截。这是刻意的 —— 它要当全表唯一的中性色，
// 靠「低饱和暖白」去对应银发＋橙黄袜的人设，而不是靠对比度抢眼。
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(255 * v));
}
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const rel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * rel(rgb[0]) + 0.7152 * rel(rgb[1]) + 0.0722 * rel(rgb[2]);
const contrast = (a, b) => { const [x, y] = [lum(hex2rgb(a)), lum(hex2rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const BG_H = 228, BG_S = 9.8, BG_L = 10;              // 八套共用同一个背景
const BG_HEX = toHex(hsl2rgb(BG_H, BG_S, BG_L));
const TEXT_HEX = '#F0F0F0';                           // --text-normal

// [id, 显示名, 强调色 h, s, l]  —— 顺序与 main.js 的 PRESETS 一致
const RAW = [
  ['miku',   'Miku',    178, 65.28, 69],
  ['rinren', 'Rin/Ren',  44, 90,    73],
  ['aoi',    'Aoi',     200, 80,    80],
  ['akane',  'Akane',   340, 100,   80],
  ['teto',   'Teto',    351, 82,    67],
  ['gumi',   'GUMI',    138, 90,    77],
  ['yukari', 'Yukari',  287, 97,    87],
  ['akari',  'Akari',    45, 18,    86],
];

console.log('背景: ' + BG_H + ' / ' + BG_S + '% / ' + BG_L + '% = ' + BG_HEX + '\n');
console.log('| 名称 | 色相 h | s | l | 强调色 | 对背景 | 对正文 ' + TEXT_HEX + ' |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
const out = [];
for (const [id, name, h, s, l] of RAW) {
  const aHex = toHex(hsl2rgb(h, s, l));
  console.log(`| ${name} | ${h} | ${s}% | ${l}% | \`${aHex}\` | ${contrast(aHex, BG_HEX).toFixed(1)} | ${contrast(aHex, TEXT_HEX).toFixed(2)} |`);
  out.push({ id, name, h, s, l, aHex });
}

console.log('\n=== 插件 main.js 里可直接粘贴的结构 ===');
for (const p of out) {
  console.log(`  { id: '${p.id}',${' '.repeat(Math.max(1, 8 - p.id.length))}name: '${p.name}',${' '.repeat(Math.max(1, 9 - p.name.length))}accent: { h: ${p.h}, s: ${p.s}, l: ${p.l} }, bg: { h: ${BG_H}, s: ${BG_S}, l: ${BG_L} } },  /* 强调 ${p.aHex} */`);
}

console.log('\n=== 相邻间距 ===');
console.log('判据：色相差 < 25° 且饱和度差 < 25 点 且明暗差 < 1.3，三条同时成立才算重复');
console.log('（色相撞但饱和度高/明暗拉得开，观感是两回事 —— 比如 Akane 浅粉 vs Teto 玫红）');
const sorted = [...out].sort((a, b) => a.h - b.h);
for (let i = 0; i < sorted.length; i++) {
  const cur = sorted[i], nxt = sorted[(i + 1) % sorted.length];
  let gap = nxt.h - cur.h; if (gap < 0) gap += 360;
  const dS = Math.abs(cur.s - nxt.s);
  const cLum = contrast(cur.aHex, nxt.aHex);
  let note = '';
  if (gap < 25 && dS < 25 && cLum < 1.3) note = '  <-- 重复';
  else if (gap < 25 && dS < 25) note = `  （色相差 ${gap}°，但明暗差 ${cLum.toFixed(2)}，靠明暗分得开）`;
  else if (gap < 25) note = `  （色相差 ${gap}°，但饱和度差 ${dS.toFixed(0)} 点，观感不同）`;
  else if (gap > 70) note = '  （大空档）';
  console.log(`  ${String(cur.h).padStart(3)} ${cur.name.padEnd(8)} -> ${String(nxt.h).padStart(3)} ${nxt.name.padEnd(8)} 色相差 ${String(gap).padStart(3)}°  饱和度差 ${dS.toFixed(0).padStart(2)}  明暗差 ${cLum.toFixed(2)}${note}`);
}

console.log('\n=== 亮度接近的成对检查（色相差够大就没事，这里只提示） ===');
for (let i = 0; i < out.length; i++) {
  for (let j = i + 1; j < out.length; j++) {
    const c = contrast(out[i].aHex, out[j].aHex);
    if (c < 1.15) console.log(`  ${out[i].name} ${out[i].aHex}  vs  ${out[j].name} ${out[j].aHex}   亮度对比 ${c.toFixed(2)}  （色相差 ${Math.abs(((out[i].h - out[j].h) % 360 + 360) % 360) < 180 ? Math.abs(out[i].h - out[j].h) : 360 - Math.abs(out[i].h - out[j].h)}°）`);
  }
}
