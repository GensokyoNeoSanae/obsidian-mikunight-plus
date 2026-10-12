'use strict';
/*
 * MikuNight++ v0.3.0
 * ------------------------------------------------------------------
 * 主题的配套增强：提供主题的全部设置项，并做那些「纯 CSS 做不到」的事
 * （需要读编辑器状态、语法树、光标位置，或需要改写文档）。
 * 不依赖任何其他插件；主题也不依赖本插件。
 *
 * 文件分两块（加/改文案只用碰第一块）：
 *   第一块 文案层 i18n —— LOCALES 词条表 + 语言检测 + t()，只有字，没有逻辑
 *   第二块 功能实现   —— 设置面板 / 编辑器扩展 / 命令，取文案一律走 t('键')
 *
 * 插件负责：
 *   1. 标记显示开关：打开时只保留光标所在行的标记（淡显 55%），
 *      其它行的标记隐藏；关掉即回到原生（所有行标记都正常色显示）。
 *   2. 成对标记整对删除：`**|**` 上一次退格删掉两侧标记，而不是只吃一个字符。
 *   3. 插入分割线命令：直接写 <hr>，绕开 CommonMark 的 setext 标题坑。
 *   4. 点击行号槽选中整行。
 *   5. 主题的显示类设置（强调色色调 / 空行高度 / 空行留白 / 公式字号 / 行号字体）：
 *      设置页写值 → 落到 body 的 CSS 变量 → 主题 theme.css 消费。
 *
 * 设计约束（与主题同一原则）：所有尺寸用 em / 相对单位，
 * 任何字号、任何缩放比例下表现一致；插件不写死像素。
 * ------------------------------------------------------------------
 */

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { RangeSetBuilder, Prec, Compartment } = require('@codemirror/state');
const { Decoration, ViewPlugin, keymap } = require('@codemirror/view');
const { syntaxTree } = require('@codemirror/language');

/* 这份 main.js 自己的版本号，必须与 manifest.json 的 version 保持一致
 * （tools/check-i18n.mjs 会核对，不一致直接报错）。
 *
 * ⚠️ 设置页顶部那行版本号刻意用**这个常量**，不用 `this.manifest.version`：
 * Obsidian 在应用启动时就把 manifest.json 读进内存缓存了（app.plugins.manifests），
 * **重载插件不会重读它**。所以改了 manifest 的版本号再重载插件，面板上还是旧版本号 ——
 * 那行字本来就是为了回答「新的 main.js 到底进内存没有」，用它反而答错（2026-10-12 实测：
 * manifest 已改成 0.3.0，重载插件后面板仍显示 v0.2.1）。 */
const BUILD_VERSION = '0.3.0';

/* ==================================================================
 * 第一块：文案层（i18n）
 * ------------------------------------------------------------------
 * 这一块**只有字，没有逻辑**：所有用户可见的字符串都集中在下面两张表里，
 * 底下的代码一律用 t('键') 取，不再出现字符串字面量。
 * 加一条文案 = 两张表各加一行；改文案 = 只动这里，不碰逻辑。
 *
 * 只有两种语言：简体中文 / 英语。
 *   **只认简体中文，其余一律英语**（包括繁体，不将就）。
 *
 * 键名规则：
 *   section.<域>          设置页的小标题
 *   setting.<id>.name     设置项名称
 *   setting.<id>.desc     设置项说明
 *   cmd.*                 命令面板里的命令名
 *   notice.*              Notice 弹窗
 *   其余按语义命名
 *
 * ⚠️ 表里的键必须成对：只加在一边的话，另一种语言下会回落到英文（见 t）。
 *    tools/check-i18n.mjs 会核对两边键是否对齐。
 * ================================================================== */

const LOCALES = {
  zh: {
    /* 插件列表里那行介绍。manifest.json 里写的是英文（社区目录全局可见），
       中文这份由 onload 覆盖上去，见 onload 里的说明。 */
    'manifest.description': 'MikuNight 主题的配套增强：强调色色调、行内标记按需隐藏、光标态提示、'
      + '公式字号跟随、百分比图片尺寸、以及那些纯 CSS 做不到的排版修正。',

    'cmd.insertHr': '插入分割线（<hr>，不会被解析成标题）',

    'section.markers': '标记显示',
    'setting.hideMarkers.name': '隐藏非选中行的标记',
    'setting.hideMarkers.desc': '打开后：光标所在行的标记淡显，其它行的标记全部隐藏（如公式块的 `$$`）。'
      + '关掉则回到 Obsidian 原生：所有行的标记都用正常颜色显示。',
    'setting.pairDelete.name': '退格整对删除标记',
    'setting.pairDelete.desc': '在 **|** 边界按退格一次删掉两侧标记；光标紧跟闭标记时一次删掉整个元素。',

    'section.gutter': '行号槽',
    'setting.clickGutter.name': '点击行号槽可选中整行',
    'setting.gutterFont.name': '行号字体名',
    'setting.gutterFont.desc': '建议使用数字等宽的字体，'
      + '这样行号不会因为数字宽度不同而左右晃。留空则使用 Obsidian 外观设置里的等宽字体。',
    /* 输入框占位符的兜底值：只在读不到 Obsidian 等宽字体名时才显示 */
    'gutterFont.fallbackName': 'Obsidian 内置等宽字体栈',

    'section.spacing': '行距',
    'setting.emptyLine.name': '空行高度系数',
    'setting.emptyLine.desc': '空行高度 = 正文行高 × 该系数。配合下一项删去留白后，空一行可实现类似“分段”的效果。',
    'setting.padEmpty.name': '压缩空行间距',
    'setting.padEmpty.desc': '勾选后把空行上下的结构性留白一并删去。'
      + '关掉则保留 Obsidian 的正常间距。',

    'section.math': '公式',
    'setting.mathScale.name': '公式字号系数',
    'setting.mathScale.desc': '公式字号 = 正文字号 × 该系数，随 Obsidian 的字号设置等比缩放。'
      + '默认 0.96 与原生观感一致，调大则公式更醒目。',

    'section.colors': '配色',
    'colors.hint': '一套配色只改「强调色 + 背景色」两个颜色。',
    'colors.applying': '正在应用',
    'colors.custom': '自定义',
    'colors.accent': '强调',
    'colors.background': '背景',
    'setting.accentSync.name': '同步 Obsidian 界面配色',
    'setting.accentSync.desc': '打开后，Obsidian 自己的强调色（设置里的按钮、侧边栏拖拽线、选中的项、勾选框…）'
      + '也跟着当前主题强调色走，不再用外观设置里选的 accentColor。'
      + '关闭即恢复外观设置里的颜色（本项不改动你的设置文件，只是运行时覆盖）。',

    'section.misc': '其他',
    'setting.reset.name': '恢复默认设置',
    'setting.reset.desc': '把本插件的全部设置项恢复成默认值（显示类设置会同时写回主题变量）。',
    'setting.reset.button': '恢复默认',
    'notice.resetDone': 'MikuNight++ 已恢复默认设置',
  },

  /* 英文文案由 subagent 产出、落在 tools/i18n-strings.en.json，这里是那份 JSON 的 1:1 副本
     （含转义方式），改动请两边一起改，tools/check-i18n.mjs 会核对键与值。 */
  en: {
    /* 这一条与 manifest.json 里的 description 必须逐字一致（check-i18n.mjs 第 ⑦ 条核对）：
       插件没被启用 / 安全模式下，用户看到的就是磁盘上那份，没机会被 onload 覆盖。 */
    "manifest.description": "Companion enhancements for the MikuNight theme: accent hue control, on-demand hiding of inline markup, cursor-state hints, math font scaling, percentage image sizing, and the typographic fixes that plain CSS cannot do.",

    "cmd.insertHr": "Insert divider (<hr>, not parsed as a heading)",

    "section.markers": "Markup display",
    "setting.hideMarkers.name": "Hide markup on unselected lines",
    "setting.hideMarkers.desc": "When enabled, markup on the cursor's line is dimmed and markup on every other line is hidden (for example `$$` in math blocks). When disabled, behavior returns to Obsidian's default, with markup on all lines shown in the normal color.",
    "setting.pairDelete.name": "Delete markup pairs with Backspace",
    "setting.pairDelete.desc": "Press Backspace at a **|** boundary to delete the markup on both sides at once; when the cursor sits right after a closing mark, delete the whole element at once.",

    "section.gutter": "Line number gutter",
    "setting.clickGutter.name": "Click the gutter to select the whole line",
    "setting.gutterFont.name": "Gutter font name",
    "setting.gutterFont.desc": "A font with equal-width digits is recommended, so the line numbers do not shift left and right as digit widths differ. Leave empty to use the monospace font from Obsidian's Appearance settings.",
    "gutterFont.fallbackName": "Obsidian built-in mono font",

    "section.spacing": "Line spacing",
    "setting.emptyLine.name": "Empty line height factor",
    "setting.emptyLine.desc": "Empty line height = body line height × this factor. Together with the next option, which removes the surrounding padding, a single empty line produces a paragraph-break-like effect.",
    "setting.padEmpty.name": "Collapse empty line padding",
    "setting.padEmpty.desc": "When enabled, the structural padding above and below empty lines is removed as well. When disabled, Obsidian's normal spacing is kept.",

    "section.math": "Math",
    "setting.mathScale.name": "Math font size factor",
    "setting.mathScale.desc": "Math font size = body font size × this factor, scaling along with Obsidian's font size setting. The default of 0.96 matches the native look; higher values make math more prominent.",

    "section.colors": "Colors",
    "colors.hint": "A preset only changes two colors: the \"accent color\" and the \"background color\".",
    "colors.applying": "Active",
    "colors.custom": "Custom",
    "colors.accent": "Accent",
    "colors.background": "Background",
    "setting.accentSync.name": "Sync Obsidian UI colors",
    "setting.accentSync.desc": "When enabled, Obsidian's own accent color (buttons in settings, sidebar drag handles, selected items, checkboxes...) follows the current theme accent color instead of the accentColor picked in Appearance settings. When disabled, the color from Appearance settings is restored (this option does not modify your settings file, it only overrides the color at runtime).",

    "section.misc": "Miscellaneous",
    "setting.reset.name": "Restore default settings",
    "setting.reset.desc": "Restore every setting of this plugin to its default value (display-related settings are written back to the theme variables as well).",
    "setting.reset.button": "Restore defaults",
    /* Notice 不加句号：Obsidian 自己的 Notice 文案一律不带句号（"Copied to clipboard" 那种口吻） */
    "notice.resetDone": "MikuNight++ settings restored to defaults",
  },
};

/** 当前界面语言标签（小写、`-` 分隔）。
 *
 * 三个来源按可靠性排序，取第一个非空的：
 *   ① document.documentElement.lang —— Obsidian 启动时按「设置 → 关于 → 语言」写在 <html> 上
 *      （实测 1.13.7：简体中文 = "zh"、繁体 = "zh-TW"、英文 = "en"），最准，也是最省事的一个。
 *   ② localStorage.language —— 同一个值的原始存放处，① 取不到时兜底。
 *   ③ navigator.language —— 系统语言。用户在 Obsidian 里显式改过语言后它会和 ① 不一致，
 *      所以只能排最后。
 */
function currentLocaleTag() {
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/_/g, '-');
  const found = [];
  try { found.push(norm(document.documentElement.lang)); } catch (e) { /* 忽略 */ }
  try { found.push(norm(window.localStorage.getItem('language'))); } catch (e) { /* 忽略 */ }
  try { found.push(norm(navigator.language)); } catch (e) { /* 忽略 */ }
  for (const tag of found) if (tag) return tag;
  return 'en';
}

/** 语言标签 → 语言包键。
 *
 * **只认简体中文**：`zh` / `zh-CN` / `zh-SG` / `zh-Hans*` → zh；
 * 繁体（`zh-TW` / `zh-HK` / `zh-Hant*`）按既定规则**同样走英语**，不做将就；
 * 其余一律 en。
 * 注意 `zh` 单独一个就是简体（Obsidian 的「简体中文」写的就是 `zh`），别把它漏了。 */
function localeFromTag(tag) {
  /* 这里也要把 `_` 归一成 `-`：入参可能来自各处的标签（如 zh_Hans），
     不能指望调用方已经清洗过 —— currentLocaleTag() 洗一次，这里再兜一次。 */
  const t = String(tag == null ? '' : tag).trim().toLowerCase().replace(/_/g, '-');
  if (t !== 'zh' && !t.startsWith('zh-')) return 'en';
  return /(^|-)(tw|hk|mo|hant)(-|$)/.test(t) ? 'en' : 'zh';
}

/* 解析一次就定下来：Obsidian 改界面语言要重启整个应用，插件没机会在运行中被换语言。
   放在模块作用域（而不是每次 t() 现算）是为了让「读到的是哪门语言」可被外部查证。 */
const LOCALE = localeFromTag(currentLocaleTag());

/** 取一条文案。查不到就回落英文，再查不到就把键名原样吐出来 —— 让漏翻一眼看得见，
 *  而不是在界面上留一片空白。
 *  支持 `{name}` 占位符：t('x.y', { n: 3 })。 */
function t(key, vars) {
  const table = LOCALES[LOCALE] || LOCALES.en;
  let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : LOCALES.en[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

const DEFAULT_SETTINGS = {
  /* --- 行为开关（必须插件实现） --- */
  hideMarkers: true,
  pairDeleteWithBackspace: true,
  clickGutterSelectsLine: true,
  /* --- 显示类设置：写到 body 的 CSS 变量上，主题 CSS 消费 --- */
  emptyLineRatio: 0.5,   /* 空行高度 = 正文行高 × 该系数 */
  padEmptyLines: true,   /* 是否把空行上下的结构性留白一并压掉 */
  mathScale: 0.96,       /* 公式字号 = 正文字号 × 该系数（0.96 ≈ Obsidian 原生观感） */
  gutterFont: 'Consolas',
  /* 配色：主题消费 --mn-accent-h/s/l 与 --mn-bg-h/s/l 六个变量（都是裸数字），
     自己不做任何色相运算。预设按钮写预设的色值，自定义按钮写取色器选的色值。 */
  accentHsl: { h: 178, s: 65.28, l: 69 },   /* 强调色 → #7ce4e0 */
  bgHsl: { h: 228, s: 9.8, l: 10 },         /* 背景色 → #17181c */
  preset: 'miku',        /* 当前套用的预设 id；用自定义取色后变成 'custom' */
  /* 同步 Obsidian 自己的强调色（设置按钮 / 侧边栏拖拽线 / 选中项…）：
     打开时给 body 挂 .mn-accent-sync，由主题里那条带 !important 的规则压掉
     app 内联在 body 上的 --accent-h/s/l；关掉即恢复外观设置里选的颜色。 */
  syncObsidianAccent: true,
};

/* ------------------------------------------------------------------
 * 预设配色
 * 每套直接存两组 HSL（强调 / 背景），不靠「色相 + 全局相位差」推 —— 想单独调某套的背景
 * 直接改这里的数就行。
 * 强调色的 s / l 按色相补偿：HSL 里同一个 l 在不同色相上的感知亮度差很大（相对亮度权重
 * R 0.2126 / G 0.7152 / B 0.0722），所以绿 / 黄绿要压低、蓝 / 紫 / 粉要抬高，
 * 各套的跳眼程度才一致。背景八套统一 228 / 9.8% / 10% = #17181c。
 * 色值换算与文字对比度见 项目/MikuNight/tools/presets-hsl.mjs，改完预设跑一遍核对。
 * ------------------------------------------------------------------ */
const PRESETS = [
  { id: 'miku',   name: 'Miku',    accent: { h: 178, s: 65.28, l: 69 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #7ce4e0 */
  { id: 'rinren', name: 'Rin/Ren', accent: { h: 44,  s: 90,    l: 73 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #f8d77c */
  { id: 'aoi',    name: 'Aoi',     accent: { h: 200, s: 80,    l: 80 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #a3daf5（琴叶葵＝蓝发，天蓝） */
  { id: 'akane',  name: 'Akane',   accent: { h: 340, s: 100,   l: 80 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #ff99bb（琴叶茜＝粉发） */
  { id: 'teto',   name: 'Teto',    accent: { h: 351, s: 82,    l: 67 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #f0667b（重音テト＝红钻头） */
  { id: 'gumi',   name: 'GUMI',    accent: { h: 138, s: 90,    l: 77 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #90f9af */
  { id: 'yukari', name: 'Yukari',  accent: { h: 287, s: 97,    l: 87 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #f0befe */
  { id: 'akari',  name: 'Akari',   accent: { h: 45,  s: 18,    l: 86 }, bg: { h: 228, s: 9.8, l: 10 } },  /* 强调 #e2dfd5（绁星灯：银发＋橙黄袜 → 香槟白，全表唯一的中性色） */
];

/**
 * 生成一块配色的按钮底图（SVG data URI）：左强调色 / 右背景色，斜边 + 圆角 + 描边。
 *
 * 关键：**按按钮真实像素尺寸生成，viewBox 与宽高 1:1，绝不缩放**。
 * 试过用固定 viewBox + preserveAspectRatio='none' 让它自动拉伸 —— 结果非均匀缩放
 * 把圆角拉成竖长的椭圆（按钮宽约为高的 4 倍），看着歪扭。所以宁可让 ResizeObserver
 * 在尺寸变化时重新生成，也不做拉伸。
 *
 * 几何：
 *   分割点靠右的比例：上沿 SPAN_TOP（1/4）、下沿 SPAN_BOTTOM（1/3）
 *   左块路径： (0,0) → (W·(1−1/4), 0) → (W·(1−1/3), H) → (0,H) → 闭合
 *   圆角：整块用 clipPath（圆角矩形）裁，圆角半径 CORNER_R（px）
 *   描边：圆角矩形加 stroke，**画在最后**，保证压住填充边缘 —— 这也顺便解决了
 *         "斜边抗锯齿留下半透明细线"的问题（细线被这圈实色描边盖住）
 * 颜色：hex 里的 # 必须编码成 %23，否则 data URI 会在 # 处被截断。
 */
const CORNER_R = 7;       /* 圆角半径（px），与 CSS 的 border-radius 保持一致 */
const SPAN_TOP = 1 / 4;   /* 上沿：斜边距右边 1/4 */
const SPAN_BOTTOM = 1 / 3;/* 下沿：斜边距右边 1/3 */

function presetBgSvg(w, h, accentHex, bgHex) {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const r = Math.min(CORNER_R, H / 2, W / 2);
  const xTop = (W * (1 - SPAN_TOP)).toFixed(1);
  const xBottom = (W * (1 - SPAN_BOTTOM)).toFixed(1);

  /* 背景层：圆角矩形（rx/ry 自带圆角，不需要裁剪）。
     强调色层：左侧色块 + 斜边，左边两个角用 arc 命令（A）自己画圆角。
     ⚠️ 这里刻意**不用 clipPath + url(#id)** —— data URI 里 # 被编码成 %23（url(%23c)），
     片段引用能否解析不保证；一旦解析失败，被裁的整个 <g> 会直接不绘制，
     表现就是"背景色整个消失、只剩底色"（踩过一次，真机截图确认）。现在零外部引用。 */
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${r}" ry="${r}" fill="${bgHex}"/>` +
    `<path d="M0 ${r} A${r} ${r} 0 0 1 ${r} 0 L${xTop} 0 L${xBottom} ${H} L${r} ${H} ` +
    `A${r} ${r} 0 0 1 0 ${H - r} Z" fill="${accentHex}"/>` +
    `</svg>`;
  return 'url("data:image/svg+xml,' + svg.replace(/#/g, '%23').replace(/"/g, "'") + '")';
}

/** HSL(裸数字) → hex，给 <input type="color"> 当值用 */
function hslToHex(c) {
  const h = ((c.h % 360) + 360) % 360, s = c.s / 100, l = c.l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(255 * v).toString(16).padStart(2, '0')).join('');
}

/** hex → HSL（h 取整、s/l 保留两位），给取色器的结果存回设置用 */
function hexToHsl(hex) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: +(s * 100).toFixed(2), l: +(l * 100).toFixed(2) };
}

/** 把显示类设置写成 CSS 变量（行内样式优先于主题里的 :root） */
function applyDisplayVars(settings) {
  const body = document.body;
  body.style.setProperty('--mn-empty-line', String(settings.emptyLineRatio ?? 1));
  body.style.setProperty('--mn-empty-pad', settings.padEmptyLines ? '0em' : '1em');
  body.style.setProperty('--mn-math-scale', String(settings.mathScale ?? DEFAULT_SETTINGS.mathScale));
  const name = (settings.gutterFont || '').trim();
  if (name) {
    /* 字体名可能带空格，统一加引号；主题那边会再补等宽兜底 */
    body.style.setProperty('--mn-gutter-font-name', `"${name}"`);
  } else {
    /* ⚠️ 留空时**不能** removeProperty：那只是把行内值撤掉，主题 :root 里那份
       `--mn-gutter-font-name: "Maple NF CN"` 会原样接管 —— 表现就是「输入框清空了、
       行号字体却纹丝不动」，设置项看着像坏的（2026-10-12 实测到的问题）。
       要让「留空 = 回落到等宽字体」真的成立，必须写一个无效值把声明打成
       guaranteed-invalid，这样主题里 `var(--mn-gutter-font-name, var(--font-monospace))`
       才会去用后面的兜底值。 */
    body.style.setProperty('--mn-gutter-font-name', 'initial');
  }
  /* 配色：六个裸数字变量。主题里直接写
     `hsl(var(--mn-accent-h) var(--mn-accent-s) var(--mn-accent-l))` 这种形式（空格语法），
     注意两点（都真机实测过）：
       ① 逗号语法的 hsl() 收不了带运算符的 calc，所以统一用空格语法；
       ② 别再造「值为 calc 的中间变量」（例如 --mn-bg-h: calc(a + b)）再往 hsl() 里塞 —— 会解析失败。
     这里写的是纯数字，所以两边都绕开了。 */
  const a = settings.accentHsl || DEFAULT_SETTINGS.accentHsl;
  const b = settings.bgHsl || DEFAULT_SETTINGS.bgHsl;
  body.style.setProperty('--mn-accent-h', String(a.h));
  body.style.setProperty('--mn-accent-s', a.s + '%');
  body.style.setProperty('--mn-accent-l', a.l + '%');
  body.style.setProperty('--mn-bg-h', String(b.h));
  body.style.setProperty('--mn-bg-s', b.s + '%');
  body.style.setProperty('--mn-bg-l', b.l + '%');

  /* 同步 Obsidian 自己的强调色：只在 body 上挂一个开关类，真正的覆盖在主题里
     （.mn-accent-sync 那三条 !important）。之所以不在 JS 里直接改 app 的
     --accent-h/s/l：app 是把它们内联写在 body 上的，插件再写一次会互相打架、
     也没法在关掉开关时干净还原；挂类则由样式表负责，关掉即恢复。 */
  body.classList.toggle('mn-accent-sync', settings.syncObsidianAccent !== false);
  /* 强调色底上的文字色：app 是按它自己存的颜色算明暗的，换成主题色后可能白字压浅底。
     这里按感知亮度给一个（浅色强调 → 深字）。 */
  body.style.setProperty('--mn-on-accent', onAccentTextColor(a));
}

/** 强调色上该配黑字还是白字（感知亮度阈值法，够用且可预测） */
function onAccentTextColor(c) {
  const hex = hslToHex(c);
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;   /* 0–255 */
  return y > 150 ? '#1a1a1a' : '#ffffff';
}

/** 读 Obsidian 现在真正在用的等宽字体名（给设置页面板显示用，不做任何写入）。
 *
 * 读的是 **`--font-monospace` 的计算值**，不是 appearance.json 里的原始字符串 ——
 * 计算值已经把 app.js 那两步（zne 切分清洗 → qne 补引号）做完，还拼好了整条兜底栈：
 *   --font-monospace = var(--font-monospace-override), var(--font-monospace-theme), var(--font-monospace-default)
 * 所以「外观设置里填了」拿到的是那个名字；「没填」拿到的是内置栈的第一个候选。
 *
 * 只取第一个候选，且去掉引号：后面的候选是"字体缺失时的兜底"，列表本身不该出现在设置界面里；
 * 引号是 CSS 书写规则，不是用户要输入的内容（写进去只会让人以为必须带引号）。
 *
 * 两个坑：
 *   ① app.css 里这两个槽位的字面值是 `'??'`（配一条只覆盖 U+0 的 @font-face），是 Obsidian 的
 *      「没有值」占位符，不是字体名，要滤掉；app.js 真写入时是把空值写成**空串**。
 *   ② 不能拿它去猜用户装没装字体 —— `document.fonts.check('16px 名字')` 误判率不低
 *      （字体只被 @font-face 引用时也可能返回 false），而且浏览器本来就会自动往后挑可用的。 */
function obsidianMonospaceFontName() {
  try {
    const v = getComputedStyle(document.body).getPropertyValue('--font-monospace') || '';
    const names = v.replace(/["']/g, '').split(',')
      .map((x) => x.trim())
      .filter((x) => x && x !== '??');
    return names[0] || '';
  } catch (e) {
    return '';
  }
}

function clearDisplayVars() {
  const body = document.body;
  for (const v of ['--mn-empty-line', '--mn-empty-pad', '--mn-math-scale', '--mn-gutter-font-name',
    '--mn-accent-h', '--mn-accent-s', '--mn-accent-l', '--mn-bg-h', '--mn-bg-s', '--mn-bg-l', '--mn-on-accent']) {
    body.style.removeProperty(v);
  }
  body.classList.remove('mn-accent-sync');
}

/* ------------------------------------------------------------------
 * 语法树节点名映射
 * Obsidian 的 markdown 节点名 = 「类名用 _ 拼起来」，不是 Lezer 标准名，实测：
 *   普通段落加粗  formatting_formatting-strong_strong
 *   列表里加粗    formatting_formatting-strong_list-1_strong
 *   引述里加粗    formatting_formatting-strong_quote_quote-1_strong
 *   标题里加粗    formatting_formatting-strong_header_header-2_strong
 *   行内代码      formatting_formatting-code_inline-code
 *   斜体          em_formatting_formatting-em
 *   ！删除线 / 高亮 / 公式同理。
 *
 * ⚠️ **不能拿「两个类名拼起来」当子串去匹配**（旧写法 'formatting-strong_strong'）：
 *    一旦标记**嵌套**在别的样式里，Obsidian 会把容器类名插进两个类名**中间**
 *    （formatting-strong + _list-1 + _strong），子串就再也匹配不上 ——
 *    表现就是「嵌套后标记不再淡显/隐藏」。实测本文档里 102 处列表加粗、
 *    8 处引述加粗、4 处标题加粗全部漏掉，而普通段落里的 158 处正常。
 *
 * 正确做法：把节点名按 _ 拆成类名，再做**整词匹配**（tokens.includes）。
 * 顺带还解决了另一个歧义：行内代码是 formatting-code，而代码围栏是
 * formatting-code-block —— 整词匹配不会把后者误判成行内代码标记。
 * ------------------------------------------------------------------ */
const MARKER_TOKENS = [
  ['formatting-strong', 'strong'],
  ['formatting-em', 'emphasis'],
  ['formatting-code', 'code'],
  ['formatting-strikethrough', 'strikethrough'],
  ['formatting-highlight', 'highlight'],
  ['formatting-math', 'math'],
  ['formatting-link', 'link'],
];

function markerKind(nodeName) {
  if (!nodeName.includes('formatting-')) return null;
  const tokens = nodeName.split('_');
  for (const [token, key] of MARKER_TOKENS) {
    if (tokens.includes(token)) return key;
  }
  return null;
}

/* 标记装饰 = 「淡显/隐藏」（按行）+「开/闭位置」（按范围）两件事拼出来的类名。
 * 为什么要分「开/闭」：行内代码在编辑态是**三段并列的 span**（左反引号 / 正文 / 右反引号），
 * 三段的圆角、内边距、边框全靠 Obsidian 自带规则和 code-styler 按**类名 + 兄弟关系**拼。
 * 拖选时装饰重建有先后，实测（tools/probe-drag-variants.js 的 C 变体：在代码里按下往左拖、
 * 不松手）端帽和正文之间会夹进 widgetBuffer（结构 `[img][span][img]`），兄弟关系一断，
 * 左端帽就变成一个整圈圆角的独立盒子 —— 用户截图里的「3 个行内代码块 / 左半独立出去」。
 * 所以插件直接把位置信息标出来：
 *   开标记 → mn-cap-open，闭标记 → mn-cap-close，中间那段正文 → mn-code-body。
 * theme.css §4 只认这三个类收边，不用赌 DOM 里谁挨着谁。
 * 位置类名只在**这一对反引号真的被展开时**才加（选区跟这段代码有交集），
 * 否则同一行里另一处还没展开的行内代码会被误伤（它只有一个整体的盒子）。 */
const markerDecoCache = new Map();
function markerDeco(cls) {
  let d = markerDecoCache.get(cls);
  if (!d) {
    d = Decoration.mark({ class: cls });
    markerDecoCache.set(cls, d);
  }
  return d;
}

/** 当前有哪些行被选中（多光标 / 整行选中都算） */
function selectionLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    lines.add(state.doc.lineAt(r.from).number);
    if (r.to > r.from) lines.add(state.doc.lineAt(r.to).number);
  }
  return lines;
}

/** 上一帧 DOM 里，哪些文档位置上的标记是真的渲染出来了（=Obsidian 已经把这对反引号展开）。
 *  为什么用 DOM 而不是选区判断：Obsidian 的「收起标记」要等松手才发生，拖选过程中选区可能
 *  已经离开这段代码、标记却还开着（实测 C 变体：选区 169..189、代码在 192..236，
 *  反引号仍是渲染出来的）；反过来 D 变体里选区刚擦到开反引号、Obsidian 又还没展开。
 *  只有「上一帧到底渲染出没有」跟用户看到的一致。
 *  折叠态反引号被 widget 顶掉、根本没有这个 span，所以同一行里另一处没展开的行内代码
 *  不会被误伤（这一点先前按选区判断时踩过：那一处的整盒外观会被剥掉）。
 *  代价：光标刚点进行内代码的那一帧，本插件还没看到展开（晚一帧），
 *  那一帧交给上面那组「相邻」规则兜底（正常情况本来就够用）。 */
function renderedMarkerStarts(view) {
  const set = new Set();
  let els;
  try {
    els = view.dom.querySelectorAll('.mn-marker-shown, .mn-marker-hidden');
  } catch (e) {
    return set;
  }
  for (const el of els) {
    try {
      set.add(view.posAtDOM(el, 0));
    } catch (e) { /* 跨行/量不到位置，忽略 */ }
  }
  return set;
}

function buildMarkerDecorations(view, settings) {
  const state = view.state;
  const doc = state.doc;
  const active = selectionLines(state);
  const rendered = renderedMarkerStarts(view);

  /* 1) 先把候选标记收下来（iterate 是文档顺序） */
  const found = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const key = markerKind(node.name);
        if (!key) return;
        if (node.to <= node.from) return;
        // 只处理「纯符号」的标记片段，不碰内容
        const text = doc.sliceString(node.from, node.to);
        if (!/^[^\w\p{L}\p{N}]+$/u.test(text) || text.trim().length === 0) return;
        found.push({ key, from: node.from, to: node.to, lineNo: doc.lineAt(node.from).number });
      },
    });
  }

  /* 2) 同一行同一类标记里，第 1 个是开、第 2 个是闭、第 3 个又是开……
        行内代码的反引号天然成对，所以「开 + 紧随其后的闭」就是一段行内代码。 */
  const counters = new Map();
  const openCodes = [];
  const closeCodes = [];
  for (const m of found) {
    const gk = m.lineNo + ':' + m.key;
    const nth = counters.get(gk) || 0;
    counters.set(gk, nth + 1);
    m.isOpen = nth % 2 === 0;
    if (m.key !== 'code') continue;
    (m.isOpen ? openCodes : closeCodes).push(m);
  }
  const pairs = [];
  for (const o of openCodes) {
    const i = closeCodes.findIndex((c) => c.lineNo === o.lineNo && c.from >= o.to);
    if (i < 0) continue;
    const c = closeCodes.splice(i, 1)[0];
    if (!rendered.has(o.from)) continue; // 这一对没展开就不碰样式
    pairs.push([o, c]);
  }
  const inPair = new Map(); // 标记对象 -> 'mn-cap-open' / 'mn-cap-close'
  for (const [o, c] of pairs) {
    inPair.set(o, 'mn-cap-open');
    inPair.set(c, 'mn-cap-close');
  }

  /* 3) 拼装饰：标记本体（淡显 + 开闭位置）+ 中间那段正文 */
  const marks = [];
  for (const m of found) {
    let cls = active.has(m.lineNo) ? 'mn-marker-shown' : 'mn-marker-hidden';
    const pos = inPair.get(m);
    if (pos) cls += ' ' + pos;
    marks.push({ from: m.from, to: m.to, deco: markerDeco(cls) });
  }
  for (const [o, c] of pairs) {
    if (c.from > o.to) marks.push({ from: o.to, to: c.from, deco: markerDeco('mn-code-body') });
  }

  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder();
  for (const m of marks) builder.add(m.from, m.to, m.deco);
  return builder.finish();
}

/* ---------------- 成对标记整对删除 ---------------- */

const PAIRS = [
  ['**', '**'], ['__', '__'], ['==', '=='], ['~~', '~~'],
  ['*', '*'], ['_', '_'], ['`', '`'], ['$', '$'],
];

function deletePair(view) {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty) return false;
  const pos = range.head;
  const doc = state.doc;

  for (const [open, close] of PAIRS) {
    const len = open.length;
    const before = doc.sliceString(Math.max(0, pos - len), pos);
    const after = doc.sliceString(pos, Math.min(doc.length, pos + len));
    if (before === open && after === close) {
      view.dispatch({
        changes: { from: pos - len, to: pos + len, insert: '' },
        selection: { anchor: pos - len },
      });
      return true;
    }
  }
  // 光标紧跟在闭标记之后：**粗体**| ← 一次删掉整个元素连同标记
  for (const [open, close] of PAIRS) {
    const len = open.length;
    const before = doc.sliceString(Math.max(0, pos - len), pos);
    if (before !== close) continue;
    const contentEnd = pos - len;
    const openIdx = doc.sliceString(0, contentEnd).lastIndexOf(open);
    if (openIdx === -1) continue;
    const inner = doc.sliceString(openIdx + len, contentEnd);
    if (inner.length === 0 || inner.includes('\n')) continue;
    view.dispatch({
      changes: { from: openIdx, to: pos, insert: '' },
      selection: { anchor: openIdx },
    });
    return true;
  }
  return false;
}

/* ---------------- 插件本体 ---------------- */

class MikuNightPlus extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    /* 把解析到的语言挂在实例上：排查「文案怎么没跟着语言走」时
       （app.plugins.plugins['mikunight-plus'].locale）一眼能看出读到了什么。 */
    this.locale = LOCALE;
    /* 版本号也挂在实例上。设置页里那行版本号已经删了，这是唯一的查询入口：
       app.plugins.plugins['mikunight-plus'].buildVersion —— 用来确认「新的 main.js 进内存没有」，
       比读 this.manifest.version 靠谱（Obsidian 缓存清单，重载插件不重读，见 BUILD_VERSION 的注释）。 */
    this.buildVersion = BUILD_VERSION;

    /* 插件列表里那行介绍也跟着语言走。
     *
     * manifest.json 是静态 JSON，Obsidian **没有**任何按语言切换元信息的机制（清单里也没有
     * i18n 相关字段），社区里甚至有人专门写插件去翻译别人插件的描述 —— 足以说明官方不管这事。
     * 但清单在内存里就是一个普通对象，而且和 `plugin.manifest` 是**同一个对象**
     * （实测 app.plugins.manifests[id] === this.manifest），所以在 onload 里改写 description
     * 就能让「设置 → 第三方插件」列表显示当前语言。
     *
     * 实测（2026-10-12）：
     *   · 改写后**不重画**列表 DOM 不会变（Obsidian 这部分没有响应式，切设置页也不会重建）；
     *   · 但**重载插件会重画那一行**，并且是从这个对象里取的值 —— 而 onload 正好发生在
     *     用户打开设置之前，所以这条路在生产路径上是成立的（已用重载插件的方式正反验证过）。
     *   · 顺带：Obsidian 缓存清单，重载插件不重读（同 BUILD_VERSION 那个坑），所以这里改的值
     *     不会被磁盘上的旧值冲掉。
     *
     * manifest.json 里那份写**英文**（社区目录只认那一份，是全局可见的），中文靠这里覆盖。 */
    this.manifest.description = t('manifest.description');

    document.body.classList.add('mn-plus-on');
    applyDisplayVars(this.settings);

    const plugin = this;

    /* 标记显示：只保留光标所在行的标记（淡显），其它行的隐藏 */
    this.registerEditorExtension([
      ViewPlugin.fromClass(
        class {
          constructor(view) {
            this.view = view;
            this.decorations = plugin.settings.hideMarkers ? buildMarkerDecorations(view, plugin.settings) : Decoration.none;
          }
          update(u) {
            if (!plugin.settings.hideMarkers) { this.decorations = Decoration.none; return; }
            if (u.docChanged || u.selectionSet || u.viewportChanged) {
              this.decorations = buildMarkerDecorations(this.view, plugin.settings);
            }
          }
        },
        { decorations: (v) => v.decorations }
      ),
    ]);

    /* 成对标记删除：用 Compartment 装填，开关一变可以热改，不用重载插件 */
    this.pairDeleteCompartment = new Compartment();
    this.registerEditorExtension([this.pairDeleteCompartment.of(this.pairDeleteExt())]);

    this.addCommand({
      id: 'insert-hr',
      name: t('cmd.insertHr'),
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const prefix = line.trim().length === 0 ? '' : '\n';
        editor.replaceRange(`${prefix}<hr>\n`, { line: cursor.line, ch: line.length });
      },
    });

    this.registerDomEvent(document, 'mousedown', (evt) => {
      if (!this.settings.clickGutterSelectsLine) return;
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      const gutterEl = target.closest('.cm-lineNumbers .cm-gutterElement');
      if (!gutterEl) return;
      const editorEl = target.closest('.cm-editor');
      if (!editorEl) return;
      let cm = null;
      this.app.workspace.iterateAllLeaves((leaf) => {
        const v = leaf.view;
        if (!v || !v.editor || !v.editor.cm) return;
        if (v.containerEl && v.containerEl.querySelector('.cm-editor') === editorEl) cm = v.editor.cm;
      });
      if (!cm) return;
      const lineNo = parseInt(gutterEl.textContent || '', 10);
      if (!Number.isFinite(lineNo)) return;
      const line = cm.state.doc.line(lineNo);
      evt.preventDefault();
      evt.stopPropagation();
      cm.dispatch({ selection: { anchor: line.from, head: line.to } });
      cm.focus();
    }, true);

    this.addSettingTab(new MikuNightPlusSettingTab(this.app, this));
  }

  /** 成对删除的扩展（按当前开关状态生成） */
  pairDeleteExt() {
    return this.settings.pairDeleteWithBackspace
      ? Prec.highest(keymap.of([{ key: 'Backspace', run: (view) => deletePair(view) }]))
      : [];
  }

  /** 重扫所有编辑器：设置项改完立刻生效，不用重载插件 */
  redrawEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
      if (!cm) return;
      cm.dispatch({
        effects: this.pairDeleteCompartment.reconfigure(this.pairDeleteExt()),
      });
    });
  }

  onunload() {
    /* 插件自己加的 body 类和显示变量，卸载时摘干净（否则主题会一直读到插件的值） */
    document.body.classList.remove('mn-plus-on');
    clearDisplayVars();
    /* 设置面板那个监听 body style 的 MutationObserver 也要断开：
       它挂在 window 上，插件重载后老实例还活着就会一直跑（症状是「改外观设置卡一下」）。 */
    if (this._phObserver) { this._phObserver.disconnect(); this._phObserver = null; }
  }
}

/* ---------------- 设置面板 ----------------
 * 本插件提供主题的全部设置：行为开关（拦按键 / 派发选区 / 写装饰）
 * 与显示类设置（写 CSS 变量、由主题 MikuNight.css 消费）。
 * 不依赖 Style Settings。
 */

class MikuNightPlusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async (alsoRedraw) => {
      await this.plugin.saveData(s);
      if (alsoRedraw) this.plugin.redrawEditors();
    };

    /* 设置页最顶上那行 `MikuNight++ vX.Y.Z` 已经删掉了（用户要求：面板不要挂版本号）。
       版本号本身还留着 —— 它现在挂在插件实例上（onload 里的 this.buildVersion），
       排查「新的 main.js 到底进内存没有」时读
       `app.plugins.plugins['mikunight-plus'].buildVersion` 即可，界面上不再显示。 */

    /* ================= 标记显示 ================= */
    containerEl.createEl('h3', { text: t('section.markers') });

    new Setting(containerEl)
      .setName(t('setting.hideMarkers.name'))
      .setDesc(t('setting.hideMarkers.desc'))
      .addToggle((tg) => tg.setValue(s.hideMarkers).onChange(async (v) => {
        s.hideMarkers = v;
        await save(true);
      }));

    new Setting(containerEl)
      .setName(t('setting.pairDelete.name'))
      .setDesc(t('setting.pairDelete.desc'))
      .addToggle((tg) => tg.setValue(s.pairDeleteWithBackspace).onChange(async (v) => {
        s.pairDeleteWithBackspace = v;
        await save(true);
      }));

    /* ================= 行号槽 ================= */
    containerEl.createEl('h3', { text: t('section.gutter') });

    new Setting(containerEl)
      .setName(t('setting.clickGutter.name'))
      .addToggle((tg) => tg.setValue(s.clickGutterSelectsLine).onChange(async (v) => {
        s.clickGutterSelectsLine = v;
        await save(false);
      }));

    /* 留空时的回落字体，直接写进输入框的**占位符**（那行淡色字）——
       输入框空着的时候，淡色字就是"现在会在用的字体"。不另写说明行（用户明确不要）。
       刷新时机：面板打开、输入变化、输入框失焦，以及 body 的 style 变了
       （= 用户刚在 Obsidian 外观设置里改了等宽字体）。 */
    const gutterFontSetting = new Setting(containerEl)
      .setName(t('setting.gutterFont.name'))
      .setDesc(t('setting.gutterFont.desc'));

    /* ⚠️ 顺序有讲究：addText 内部会调 setPlaceholder('Maple NF CN')，
       所以写入必须在 addText 跑完之后 —— 早先那版在 addText 之前就缓存了 input 元素，
       一旦那时元素还没建出来，后面所有刷新都会静默失效（表现就是"改了没用"）。
       现在改成每次现查元素，不再依赖任何缓存下来的引用。 */
    let fontSetting = null;
    const fontInputEl = () => (fontSetting ? fontSetting.controlEl.querySelector('input') : null);

    const refreshPlaceholder = () => {
      const el = fontInputEl();
      /* 灰色占位符只在"输入框真的空着"时才代表当前生效值 */
      if (!el || (s.gutterFont || '').trim() !== '') return;
      /* 只取**第一个**字体名，且不带引号。
         为什么去掉引号：引号是 CSS 里的书写规则（含空格的名字必须加，否则会被解析成两个字体名），
         但摆进输入框当示例会误导人以为"打上引号才能被识别"。
         为什么只留第一个：后面的候选是浏览器在字体缺失时的兜底，列出来只会让人以为要填一串。 */
      const name = obsidianMonospaceFontName();
      const ph = name || t('gutterFont.fallbackName');
      if (el.placeholder === ph) return;
      el.placeholder = ph;
    };

    fontSetting = gutterFontSetting
      .addText((tx) => tx
        .setPlaceholder('Maple NF CN')
        .setValue(s.gutterFont ?? '')
        .onChange(async (v) => {
          s.gutterFont = v;
          applyDisplayVars(s);
          refreshPlaceholder();
          await save(false);
        }));

    /* addText 跑完再刷一次 —— 它内部的 setPlaceholder('Maple NF CN') 会把占位符覆盖回去 */
    refreshPlaceholder();
    if (this._phObserver) this._phObserver.disconnect();
    this._phObserver = new MutationObserver(refreshPlaceholder);
    this._phObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    const el0 = fontInputEl();
    if (el0) el0.addEventListener('blur', refreshPlaceholder);

    /* ================= 行距 ================= */
    containerEl.createEl('h3', { text: t('section.spacing') });

    new Setting(containerEl)
      .setName(t('setting.emptyLine.name'))
      .setDesc(t('setting.emptyLine.desc'))
      .addSlider((sl) => sl.setLimits(0, 1, 0.05).setValue(s.emptyLineRatio ?? 1).setDynamicTooltip()
        .onChange(async (v) => {
          s.emptyLineRatio = v;
          applyDisplayVars(s);
          await save(true);
        }));

    new Setting(containerEl)
      .setName(t('setting.padEmpty.name'))
      .setDesc(t('setting.padEmpty.desc'))
      .addToggle((tg) => tg.setValue(s.padEmptyLines ?? true).onChange(async (v) => {
        s.padEmptyLines = v;
        applyDisplayVars(s);
        await save(true);
      }));

    /* ================= 公式 ================= */
    containerEl.createEl('h3', { text: t('section.math') });

    new Setting(containerEl)
      .setName(t('setting.mathScale.name'))
      .setDesc(t('setting.mathScale.desc'))
      /* 步长必须是 0.02 而不是 0.05：默认值 0.96 不在 0.05 的格子上（0.80 / 0.85 / 0.90 / 0.95 / 1.00…），
         用户一旦拖动滑杆就再也回不到 0.96 了。0.02 的格子包含 0.96，也包含旧值 1.20。 */
      .addSlider((sl) => sl.setLimits(0.8, 2, 0.02).setValue(s.mathScale ?? DEFAULT_SETTINGS.mathScale).setDynamicTooltip()
        .onChange(async (v) => {
          s.mathScale = v;
          applyDisplayVars(s);
          await save(false);
        }));

    /* ================= 配色 ================= */
    containerEl.createEl('h3', { text: t('section.colors') });

    /* ---------- 第 1、2 行：8 套预设，一行四个，自动填满整行 ---------- */
    containerEl.createEl('p', {
      text: t('colors.hint'),
      cls: 'mn-preset-hint',
    });
    const grid = containerEl.createDiv({ cls: 'mn-preset-grid' });

    for (const p of PRESETS) {
      const active = (s.preset ?? '') === p.id;
      const btn = grid.createEl('button', { cls: 'mn-preset-btn' + (active ? ' is-active' : '') });
      /* 底色 = 强调色（兜底，也用于选中态压暗层）；底图见 presetBgSvg()。 */
      const accentHex = hslToHex(p.accent);
      const bgHex = hslToHex(p.bg);
      btn.style.setProperty('--mn-preset-accent', accentHex);
      btn.style.setProperty('--mn-preset-bg', bgHex);
      btn.dataset.preset = p.id;
      btn.dataset.presetName = p.name;
      btn.createSpan({ cls: 'mn-preset-name', text: active ? t('colors.applying') : p.name });

      /* 底图按真实像素尺寸生成（不拉伸，见 presetBgSvg 的说明）。
         注意只量 padding box（减去边框宽度）—— 底图是铺在 padding box 里的（background-clip），
         用 border box 尺寸去画会让图形被裁掉 2px。尺寸变化就重新生成。 */
      const paint = () => {
        const cs = getComputedStyle(btn);
        const bw = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        const bh = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        const w = btn.clientWidth || (btn.getBoundingClientRect().width - bw);
        const h = btn.clientHeight || (btn.getBoundingClientRect().height - bh);
        if (w < 1 || h < 1) return;
        btn.style.backgroundImage = presetBgSvg(w, h, accentHex, bgHex);
      };
      /* 先同步画一次：面板重建时按钮已经在 DOM 里、布局也就绪，这里同步生效
         → 根本不存在「底图晚一帧」的窗口。尺寸还是 0（面板没显示出来）时
         paint() 按上面的早退逻辑退出，交给下面这次 rAF / ResizeObserver。 */
      paint();
      requestAnimationFrame(() => {
        paint();
        if (typeof ResizeObserver !== 'undefined') {
          btn._mnRO = new ResizeObserver(paint);
          btn._mnRO.observe(btn);
        }
      });

      btn.addEventListener('click', async () => {
        s.preset = p.id;
        s.accentHsl = Object.assign({}, p.accent);
        s.bgHsl = Object.assign({}, p.bg);
        applyDisplayVars(s);
        /* ⚠️ 这里**不要** this.display()。重画整个面板会把八个按钮的斜角底图（SVG，按真实
           像素尺寸生成，只能等元素进 DOM 之后才画得出来）一起清掉，重建后要等下一帧 rAF
           才补上 —— 于是有概率先闪一帧「只剩兜底纯强调色、圆角矩形」的画面。
           选中态本来就有唯一入口 syncActive()，重画唯一多做的事是把两个取色器的值刷成
           新预设的颜色，手动补两行即可。 */
        accentInput.value = hslToHex(s.accentHsl);
        bgInput.value = hslToHex(s.bgHsl);
        syncActive();                     /* 先给反馈，再去落盘 */
        await save(false);
      });
    }

    /* ---------- 第 3 行：自定义。独占一行，两个取色器横排、不换行 ---------- */
    const customRow = containerEl.createDiv({ cls: 'mn-custom-row' });
    const customName = customRow.createSpan({ cls: 'mn-preset-name' });
    const pickRow = customRow.createDiv({ cls: 'mn-picker-row' });

    /* 选中态**只有一个来源**：settings.preset。所有界面状态都由这个函数统一刷 ——
       不要在事件里各改各的 DOM（之前就是那样，结果自定义和预设同时显示「正在应用」）。
       它只刷状态、不重画控件，所以取色器拖到一半也不会被打断。 */
    const allBtns = [...grid.querySelectorAll('.mn-preset-btn')];
    const syncActive = () => {
      const cur = s.preset ?? '';
      for (const b of allBtns) {
        const on = cur !== '' && cur !== 'custom' && b.dataset.preset === cur;
        b.classList.toggle('is-active', on);
        const nm = b.querySelector('.mn-preset-name');
        if (nm) nm.setText(on ? t('colors.applying') : b.dataset.presetName);
      }
      const customOn = cur === 'custom';
      customRow.classList.toggle('is-active', customOn);
      customName.setText(customOn ? t('colors.applying') : t('colors.custom'));
    };

    const mkPicker = (label, which, current) => {
      const wrap = pickRow.createEl('label', { cls: 'mn-picker' });
      wrap.createSpan({ cls: 'mn-picker-label', text: label });
      const input = wrap.createEl('input', { cls: 'mn-picker-input', type: 'color' });
      input.value = hslToHex(current);
      input.addEventListener('input', async () => {
        const hsl = hexToHsl(input.value);
        if (which === 'accent') s.accentHsl = hsl; else s.bgHsl = hsl;
        s.preset = 'custom';
        applyDisplayVars(s);
        await save(false);
        syncActive();          /* 唯一的选中态更新入口 */
      });
      return input;
    };
    /* 这两个引用被上面的预设点击处理器用到（点预设要把取色器的值刷成新配色）——
       声明在下面没问题，处理器只在用户点击时才跑。 */
    const accentInput = mkPicker(t('colors.accent'), 'accent', s.accentHsl || DEFAULT_SETTINGS.accentHsl);
    const bgInput = mkPicker(t('colors.background'), 'bg', s.bgHsl || DEFAULT_SETTINGS.bgHsl);

    syncActive();              /* 初始同步一次：保证首屏也只有一块是「正在应用」 */

    /* ---------- 同步 Obsidian 自己的强调色 ---------- */
    new Setting(containerEl)
      .setName(t('setting.accentSync.name'))
      .setDesc(t('setting.accentSync.desc'))
      .addToggle((tg) => tg.setValue(s.syncObsidianAccent !== false).onChange(async (v) => {
        s.syncObsidianAccent = v;
        applyDisplayVars(s);
        await save(false);
      }));

    /* ================= 其他 ================= */
    containerEl.createEl('h3', { text: t('section.misc') });

    new Setting(containerEl)
      .setName(t('setting.reset.name'))
      .setDesc(t('setting.reset.desc'))
      .addButton((b) => b.setButtonText(t('setting.reset.button')).setWarning().onClick(async () => {
        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
        applyDisplayVars(this.plugin.settings);
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.redrawEditors();
        new Notice(t('notice.resetDone'));
        this.display();
      }));
  }
}

module.exports = MikuNightPlus;
