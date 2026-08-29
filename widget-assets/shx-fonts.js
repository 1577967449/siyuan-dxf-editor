/*
 * shx-fonts.js — 真实 SHX 矢量字形渲染（替代系统字体近似）
 *
 * 设计：
 *  - 加载 @mlightcad/shx-parser 解析 SHX 字形矢量（与 AutoCAD 内部同源）。
 *  - 用 fit_calib 反解出的标定表（shx-calib.js → window.SHX_CALIB）把字形坐标
 *    映射到世界单位，公式（H = DXF 字高）：
 *        worldX = H * s * (emX + lx)
 *        worldY = H * (s * ly + oy)
 *    其中 (lx,ly) 是 parser 在 size=1 下的字形坐标，s/oy 逐字体标定（与 AutoCAD
 *    (textbox) 真值 0 误差拟合）。
 *  - 多字节（CJK）按 GBK/Big5 反查表定位 bigfont 字形码。
 *  - 输出"局部世界坐标"折线（y 向上、基线在 y=0、首字左缘 x=0），由 dxf-render
 *    负责对齐/旋转/宽度因子/描边。
 *
 * 同时支持浏览器（fetch + window['shx-parser']）与 Node（fs + require）。
 */
(function (global) {
  'use strict';

  var isNode = (typeof module !== 'undefined' && module.exports);
  var SP = isNode ? require('./shx-parser.cjs')
                  : (global['shx-parser'] || (typeof window !== 'undefined' ? window['shx-parser'] : null));
  if (!SP) throw new Error('shx-parser not available');
  var ShxFont = SP.ShxFont;
  var getAdvanceWidth = SP.getAdvanceWidth;

  var CALIB = (typeof window !== 'undefined' && window.SHX_CALIB)
    ? window.SHX_CALIB
    : (isNode ? require('./shx-calib.json') : null);

  // AutoCAD 字体替换表 acad.fmp：引用字体缺失时 AutoCAD 用它替代（510 条）。
  // 例：stedi(缺失) -> Tssdchn.shx(存在)。键=被引用名(小写无后缀)，值=替代文件名。
  var FMP = (typeof window !== 'undefined' && window.SHX_FMP)
    ? window.SHX_FMP
    : (isNode ? require('./acad-fmp.json') : null);

  function subKey(key) {
    if (!FMP || !key) return null;
    var v = FMP[key];
    if (!v) return null;
    var sk = normKey(v);                 // "Tssdchn.shx" -> "tssdchn"
    return (sk && sk !== key) ? sk : null;
  }

  // ---- 编码反查表 Unicode -> 双字节码 ----
  function buildMap(enc) {
    var dec = new TextDecoder(enc, { fatal: false });
    var map = {};                 // codePoint -> int (lead<<8|trail)
    var buf = new Uint8Array(2);
    for (var lead = 0x81; lead <= 0xfe; lead++) {
      for (var trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        buf[0] = lead; buf[1] = trail;
        var s = dec.decode(buf);
        if (s.length === 1) {
          var cp = s.codePointAt(0);
          if (cp !== 0xfffd && map[cp] === undefined) map[cp] = (lead << 8) | trail;
        }
      }
    }
    return map;
  }
  var MAPS = { gbk: buildMap('gbk'), big5: buildMap('big5') };

  // TrueType 字体名（Windows 自带，AutoCAD 也按 TTF 渲染 → 用系统字体近似最准）
  var TTF_NAMES = {
    'arial': 1, 'simhei': 1, '黑体': 1, 'simsun': 1, '宋体': 1, 'nsimsun': 1,
    'simfang': 1, '仿宋': 1, 'stxihei': 1, 'stfangso': 1, 'yu gothic': 1,
    'fsgb2312': 1, 'ktgb2312': 1, 'ms gothic': 1, 'meiryo': 1, 'microsoft yahei': 1,
    '微软雅黑': 1, 'times new roman': 1, 'courier new': 1, 'calibri': 1,
    'verdana': 1, 'tahoma': 1, '楷体': 1, 'kai': 1
  };

  // 通用兜底 SHX：缺失的 SHX 字体用自带标准 SHX 替代（与 快速看图 / AutoCAD FONTALT 一致），
  // 绝不直接回退 Windows 系统字体。顺序即优先级。
  var DEFAULT_LATIN = ['txt', 'simplex', 'romans'];     // 西文/小字体兜底
  var DEFAULT_BIG   = ['gbcbig', 'hztxt', 'chineset'];  // 中文大字体兜底

  var FONT_BASE = 'fonts/';
  var cache = {};                 // key -> ShxFont | null
  var cachePending = {};          // key -> Promise

  function normKey(name) {
    if (!name) return '';
    var s = String(name).trim();
    s = s.replace(/^.*[\\/]/, '');
    s = s.replace(/\.(shx|ttf|ttc|otf|pfb)$/i, '');
    return s.toLowerCase();
  }

  function loadFontNode(key) {
    if (cache[key] !== undefined) return cache[key];
    var p = FONT_BASE + key + '.shx';
    try {
      var b = require('fs').readFileSync(p);
      cache[key] = new ShxFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    } catch (e) { cache[key] = null; }
    return cache[key];
  }

  function loadFontBrowser(key) {
    if (cache[key] !== undefined) return cache[key];   // null = 已知缺失
    if (cachePending[key]) return null;                // 正在加载
    cachePending[key] = fetch(FONT_BASE + key + '.shx')
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        cache[key] = new ShxFont(buf);
        delete cachePending[key];
        return cache[key];
      })
      .catch(function () { cache[key] = null; delete cachePending[key]; return null; });
    return null;
  }

  function loadFont(key) {
    return isNode ? loadFontNode(key) : loadFontBrowser(key);
  }

  // 预加载一组字体（浏览器异步）；返回 Promise
  function preload(keys) {
    if (isNode) { keys.forEach(loadFontNode); return Promise.resolve(); }
    var ps = [];
    keys.forEach(function (k) {
      var f = loadFontBrowser(k);
      if (f && cachePending[k]) ps.push(cachePending[k]);
    });
    return Promise.all(ps).then(function () { return; });
  }

  function isBigType(font) {
    try {
      var t = font.fontData.header.fontType;
      return t === 'bigfont' || t === 'BIGFONT';
    } catch (e) { return false; }
  }

  // 选西文字体：依次试 key → FMP 替代 → simplex(FONTALT)；命中即返回 {font,cal,key}
  function pickLatin(key) {
    var tried = {};
    var k = key;
    for (var g = 0; g < 4; g++) {
      if (!k || tried[k]) break;
      tried[k] = 1;
      var f = loadFont(k);
      if (f && !isBigType(f)) {
        var c = CALIB && CALIB[k];
        if (c && !c.unsupported) return { font: f, cal: c, key: k };
      }
      var sk = subKey(k);
      if (!sk || tried[sk]) break;
      k = sk;
    }
    // 通用兜底：缺失的西文/小字体 SHX → 用自带标准 SHX 替代（不回退系统字体）
    for (var di = 0; di < DEFAULT_LATIN.length; di++) {
      var dk = DEFAULT_LATIN[di];
      if (dk === key || tried[dk]) continue;
      var df = loadFont(dk);
      if (df && !isBigType(df)) {
        var dc = CALIB && CALIB[dk];
        if (dc && !dc.unsupported) return { font: df, cal: dc, key: dk, substituted: key };
      }
    }
    return null;
  }

  // 选大字体（CJK）：先试 key，再沿 FMP 链替代，最后用标准中文大字体兜底
  function pickBig(key) {
    if (!key) return null;
    var tried = {};
    var k = key;
    for (var g = 0; g < 4; g++) {
      if (!k || tried[k]) break;
      tried[k] = 1;
      var f = loadFont(k);
      if (f && isBigType(f)) {
        var c = CALIB && CALIB[k];
        if (c && !c.unsupported) return { font: f, cal: c, key: k };
      }
      var sk = subKey(k);
      if (!sk || tried[sk]) break;
      k = sk;
    }
    // 通用兜底：缺失的中文大字体 SHX → 用自带标准中文大字体替代（不回退系统字体）
    for (var bi = 0; bi < DEFAULT_BIG.length; bi++) {
      var bk2 = DEFAULT_BIG[bi];
      if (bk2 === key || tried[bk2]) continue;
      var bf = loadFont(bk2);
      if (bf && isBigType(bf)) {
        var bc = CALIB && CALIB[bk2];
        if (bc && !bc.unsupported) return { font: bf, cal: bc, key: bk2, substituted: key };
      }
    }
    return null;
  }

  // 解析样式 → 决定 latin / big 用哪个 SHX（及标定），或回退系统字体
  function resolveStyle(primaryKey, bigKey) {
    primaryKey = normKey(primaryKey);
    bigKey = normKey(bigKey);

    // TrueType 名 → 系统字体（最准）
    if (TTF_NAMES[primaryKey]) return { ok: false, system: true, reason: 'ttf' };

    var latin = primaryKey ? pickLatin(primaryKey) : null;
    var big = bigKey ? pickBig(bigKey) : null;

    // 安全兜底：任何 SHX 名（非 TTF）都应解析为 SHX 矢量字形，绝不直接回退系统字体
    if (!latin && !big && !TTF_NAMES[primaryKey]) latin = pickLatin(DEFAULT_LATIN[0]);

    var ok = !!(latin || big);
    return { ok: ok, system: false, latin: latin, big: big, primaryKey: primaryKey, bigKey: bigKey };
  }

  // 单字符 → 字形记录（决定用哪个字体、码、标定）
  function glyphFor(ch, style) {
    var cp = ch.codePointAt(0);
    if (cp >= 0x80) {
      if (style.big) {
        var enc = style.big.cal.enc || 'gbk';
        var m = MAPS[enc];
        var code = m ? m[cp] : undefined;
        if (code !== undefined && style.big.font.hasChar(code)) {
          return { g: style.big, code: code, isBig: true };
        }
      }
      // 大字体不可用或查不到码 → 试主字体（部分西文字体也能出字形）
      if (style.latin && style.latin.font.hasChar(cp)) {
        return { g: style.latin, code: cp, isBig: false };
      }
      return null;
    }
    if (style.latin && style.latin.font.hasChar(cp)) {
      return { g: style.latin, code: cp, isBig: false };
    }
    return null;
  }

  // 单字形前进宽度（世界单位 @H=1）——与 AutoCAD 标定一致
  //  - 等宽 CJK：用实测世界宽 advWorld（与横纵缩放无关）
  //  - 西文：横向缩放 sc × advRatio × 字形末点 x（parser 单位）
  function advanceWorld(g, shape) {
    var cal = g.g.cal;
    var sc = (cal.sx != null) ? cal.sx : cal.s;
    if (g.isBig && cal.advWorld != null) return cal.advWorld;
    var adv = (shape.lastPoint && shape.lastPoint.x != null) ? shape.lastPoint.x : getAdvanceWidth(shape);
    var ar = cal.advRatio;
    return sc * (ar != null ? ar : 1) * adv;
  }

  // 布局一行文本 → { ok, polylines:[[{x,y}...]], width, height }
  // 坐标：局部世界单位，y 向上，基线在 y=0，首字左缘 x=0。
  function layoutLine(text, style, H) {
    if (!style || !style.ok) return { ok: false };
    var chars = Array.from(text);
    var glyphs = [];
    for (var i = 0; i < chars.length; i++) {
      var gf = glyphFor(chars[i], style);
      if (!gf) return { ok: false, reason: 'char-missing' };
      var shape = gf.g.font.getLayoutCharShape(gf.code, 1);
      if (!shape || !shape.polylines || !shape.polylines.length) return { ok: false, reason: 'no-shape' };
      glyphs.push({ gf: gf, shape: shape });
    }

    var polylines = [];
    var worldX = 0;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (var j = 0; j < glyphs.length; j++) {
      var g = glyphs[j].gf, sh = glyphs[j].shape;
      var sc = (g.g.cal.sx != null) ? g.g.cal.sx : g.g.cal.s;  // 横向缩放
      var sv = (g.g.cal.sy != null) ? g.g.cal.sy : g.g.cal.s;  // 纵向缩放
      var oy = g.g.cal.oy;
      for (var pi = 0; pi < sh.polylines.length; pi++) {
        var pl = sh.polylines[pi];
        if (!pl || pl.length < 2) continue;
        var out = [];
        for (var k = 0; k < pl.length; k++) {
          var lx = pl[k].x, ly = pl[k].y;
          var wx = worldX + H * sc * lx;
          var wy = H * (sv * ly + oy);
          out.push({ x: wx, y: wy });
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        }
        polylines.push(out);
      }
      worldX += H * advanceWorld(g, sh);
    }
    if (!isFinite(minX)) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      polylines: polylines,
      width: maxX - minX,
      height: maxY - minY,
      minX: minX, maxX: maxX, minY: minY, maxY: maxY
    };
  }

  var API = {
    resolveStyle: resolveStyle,
    layoutLine: layoutLine,
    preload: preload,
    normKey: normKey,
    substitute: subKey,
    setFontBase: function (p) { FONT_BASE = p; },
    isReady: function (keys) {
      if (isNode) return true;
      for (var i = 0; i < keys.length; i++) if (loadFontBrowser(keys[i]) === null && cache[keys[i]] === undefined) return false;
      return true;
    },
    _loadFont: loadFont
  };

  if (isNode) module.exports = API;
  else global.ShxText = API;
})(typeof window !== 'undefined' ? window : this);
