/*
 * dxf-render.js — Canvas2D 渲染器，显示口径对齐 AutoCAD 2025
 *
 * 关键约定（与 AutoCAD 一致）：
 *  - 模型空间黑底；7 号色 = 白色；ByLayer/ByBlock 正确回溯；图层 OFF/冻结不显示
 *  - LWDISPLAY 默认关闭 => 所有线 1px（不按 lineweight 加粗）
 *  - 线型按 LTYPE 表的 49 组虚线段长绘制，随 LTSCALE 缩放
 *  - 圆弧逆时针 a50->a51；屏幕 Y 轴翻转后用 [-a51,-a50] 正向绘制
 *  - ZOOM ALL 优先用 HEADER $EXTMIN/$EXTMAX（这正是 AutoCAD 自己的图形范围）
 *
 * 导航（AutoCAD 习惯）：滚轮 = 光标处缩放；中键拖 = 平移；中键双击 = 范围缩放；右键拖 = 平移
 * 性能：视口剔除 + 按样式批量成路径一次描边 + 亚像素实体跳过
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var D2R = Math.PI / 180;

  function DxfRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.doc = null;
    this.spaces = {};
    this.spaceNames = [];
    this.currentSpace = '模型';
    this.scale = 1;
    this.centerX = 0; this.centerY = 0;
    this.selected = -1;
    this.visibleLayers = {};
    this.overlays = [];
    this.snapPoint = null;
    this.bgColor = '#000000';
    this.showLineweight = false;     // 对应 AutoCAD LWDISPLAY
    this.showLinetype = true;
    this.dragMoved = false;
    this._downPt = null; this._dragStart = null;
    this._panning = false;
    this.snap = { on: false, modes: { endpoint: true, nearest: true, center: true, mid: true, perp: true, tangent: true, intersect: true } };
    this.onView = null;              // 视图变化回调（供状态栏刷新）
    // SHX→系统字体映射（useSystemFontForShx，默认开启）：把 SHX 字体名（txt.shx / hztxt.shx 等）
    // 经 SHX_SUBST 表映射为系统字体族（Tahoma / 宋体…），用浏览器原生字体引擎填充渲染，
    // 彻底不依赖 shx 字库，消除白团/线宽/缩放等显示问题；思源与单机 index.html 完全一致。
    this.useSystemFontForShx = true;  // true：SHX 走系统字体（推荐，零 SHX 依赖）；false：走旧 ShxText 描边
    // 重要：思源(embed/dock)与单机 index.html 使用【完全相同的渲染参数与 fit 行为】，保证两者显示一致。
    this.textScaleSys = 1.0;          // 系统字体 / 中文回退：保持原比例
    this.minTextPxSys = 3;            // 系统字体最小 3px：再小就糊成点，3px 还能辨认
    this.maxTextPxSys = 128;          // 上限安全值，极端放大不爆屏
    this.textScaleShx = 4.0;          // 仅旧 SHX 描边路径使用：保持与旧 SHX 描边一致的视觉字号（默认已关闭 SHX 描边，映射为系统字体后不再使用此系数）
    this.minTextPxShx = 16;           // 仅旧 SHX 描边路径使用：低于此值时 canvas 1px 最小线宽会让笔画粗过字身，导致白团/刺猬
    this.maxTextPxShx = 0;            // 仅旧 SHX 描边路径使用：0 表示不限制，让放大时 SHX 与几何图形同步线性放大
    this.shxLineWidth = 1;            // 仅旧 SHX 描边路径使用：恒定线宽 1 CSS 像素
    // 检测是否在思源内嵌入/侧栏模式（URL 带 ?embed=1 或 ?dock=1）
    this.embedMode = (typeof location !== 'undefined' && /[?&](embed|dock)=/.test(location.search || ''));
    // 思源=单机：默认关闭 embed 专属文字放大 boost，让 embed/dock 视图与单机 index.html 完全一致。
    // 若日后需要恢复思源内“小面板可读性增强”，把它设为 true 即可。
    this.boostTextInEmbed = false;
    this._bindEvents();
  }

  // ---------------------------------------------------------------- 事件/导航
  DxfRenderer.prototype._bindEvents = function () {
    var self = this, c = this.canvas;

    c.addEventListener('mousedown', function (e) {
      self._downPt = { x: e.clientX, y: e.clientY };
      self._dragStart = { x: e.clientX, y: e.clientY };
      self.dragMoved = false;
      if (e.button === 1 || e.button === 2) {     // 中键/右键 = 平移
        self._panning = true;
        c.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    c.addEventListener('mousemove', function (e) {
      if (!self._downPt) return;
      var dx = e.clientX - self._dragStart.x, dy = e.clientY - self._dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) self.dragMoved = true;
      if (self._panning) {
        self.centerX -= dx / self.scale;
        self.centerY += dy / self.scale;
        self._dragStart = { x: e.clientX, y: e.clientY };
        self.render();
      }
    });

    function endDrag() {
      self._downPt = null;
      if (self._panning) { self._panning = false; c.style.cursor = ''; }
    }
    c.addEventListener('mouseup', endDrag);
    c.addEventListener('mouseleave', endDrag);
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = c.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var f = (e.deltaY < 0) ? 1.15 : 1 / 1.15;   // 与 AutoCAD ZOOMFACTOR 手感接近
      self.zoom(f, mx, my);
    }, { passive: false });

    c.addEventListener('dblclick', function (e) {
      if (e.button === 1) { self.fit(); }
    });
    // 中键双击 = ZOOM EXTENTS
    var lastMid = 0;
    c.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      var t = Date.now();
      if (t - lastMid < 400) self.fit();
      lastMid = t;
    });

    // ResizeObserver：思源里嵌入块 / 侧栏尺寸变化时，iframe 自身 window.resize 未必触发，
    // 导致画布位图尺寸与显示尺寸不符（文字发虚、错位）。监听画布真实尺寸：
    //   首次拿到非零尺寸 → 做一次 fit()（修正思源首屏常因 0 尺寸而 fit 到兜底 800x600 的问题）；
    //   之后仅 render()，保留用户当前的缩放 / 平移。
    if (typeof ResizeObserver !== 'undefined') {
      var _rpending = false;
      var _rschedule = function (fn) {
        if (_rpending) return;
        _rpending = true;
        requestAnimationFrame(function () { _rpending = false; fn(); });
      };
      var _ro = new ResizeObserver(function () {
        var w = c.clientWidth, h = c.clientHeight;
        if (!w || !h) return;
        // 同步触发 window resize，让 app.js 的 overlay/十字光标也跟随 canvas 尺寸变化，
        // 否则 overlay 旧内容（如橡皮筋、捕捉框）会残留在已变化的画布上。
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          try { window.dispatchEvent(new Event('resize')); } catch (err) {}
        }
        if (!self._didFit) {
          self._didFit = true;
          _rschedule(function () { self.fit(); });
        } else {
          _rschedule(function () { self.render(); });
        }
      });
      _ro.observe(c);
    }
  };

  DxfRenderer.prototype.load = function (doc) {
    this.doc = doc;
    this.spaces = {};
    this.spaceNames = ['模型'];
    this.spaces['模型'] = this._prepare(DxfParser.flatten(doc, { maxDepth: 16 }), doc);

    var names = Object.keys(doc.layouts || {}).sort(function (a, b) {
      return (doc.layouts[a].tabOrder || 0) - (doc.layouts[b].tabOrder || 0);
    });
    for (var i = 0; i < names.length; i++) {
      var L = doc.layouts[names[i]];
      if (L.blockName && doc.blocks[L.blockName]) {
        var blk = doc.blocks[L.blockName];
        var pe = DxfParser.flatten(doc, { maxDepth: 16, entities: blk.entities });
        var sp = this._prepare(pe, doc);
        sp.isPaper = true;
        sp.viewports = this._extractViewports(blk.entities);
        this.spaces[names[i]] = sp;
        this.spaceNames.push(names[i]);
      }
    }
    // 图层可见性初值 = AutoCAD 的 ON/OFF 状态
    this.visibleLayers = {};
    for (var ln in doc.layers) this.visibleLayers[ln] = !doc.layers[ln].off;
    this.currentSpace = '模型';
    this.selected = -1;
  };

  function pct(arr, p) { if (!arr.length) return 0; return arr[Math.floor(p * (arr.length - 1))]; }

  DxfRenderer.prototype._prepare = function (entities, doc) {
    var n = entities.length;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    var allX = [], allY = [];
    for (var i = 0; i < n; i++) {
      var e = entities[i];
      var bb = bbox(e, this);
      e._bb = bb;
      if (bb) {
        if (bb.x0 < minx) minx = bb.x0; if (bb.y0 < miny) miny = bb.y0;
        if (bb.x1 > maxx) maxx = bb.x1; if (bb.y1 > maxy) maxy = bb.y1;
        allX.push(bb.x0, bb.x1); allY.push(bb.y0, bb.y1);
      }
    }
    // 坏数据（如 x=-1.5e10 的野顶点）标记为退化，AutoCAD 同样忽略
    var magX = 1, magY = 1;
    if (allX.length) {
      allX.sort(function (a, b) { return a - b; }); allY.sort(function (a, b) { return a - b; });
      magX = Math.max(Math.abs(pct(allX, 0.005)), Math.abs(pct(allX, 0.995))) || 1;
      magY = Math.max(Math.abs(pct(allY, 0.005)), Math.abs(pct(allY, 0.995))) || 1;
    }
    var thr = Math.max(1e9, magX * 1000, magY * 1000);
    // 稳健包围盒 rbounds：用「每个实体的代表点(中心)」计算百分位，而非全部包围盒角点。
    // 角点法会让一两个远离主体、坐标达数十亿(或贴近原点)的孤点把 0.2%/99.8% 百分位也拽到极端值，
    // 导致 ZOOM EXTENTS / ZOOM DENSE 把整图缩成亚像素。逐实体中心只提供 1 个点，孤点无法主导分位。
    var cx = [], cy = [];
    for (var j = 0; j < n; j++) {
      var en = entities[j], b2 = en._bb;
      en._degenerate = !!(b2 && (Math.abs(b2.x0) > thr || Math.abs(b2.x1) > thr || Math.abs(b2.y0) > thr || Math.abs(b2.y1) > thr));
      if (b2 && !en._degenerate) { cx.push((b2.x0 + b2.x1) / 2); cy.push((b2.y0 + b2.y1) / 2); }
    }
    var rb;
    if (cx.length) {
      cx.sort(function (a, b) { return a - b; }); cy.sort(function (a, b) { return a - b; });
      rb = { x0: pct(cx, 0.01), y0: pct(cy, 0.01), x1: pct(cx, 0.99), y1: pct(cy, 0.99) };
    } else rb = { x0: minx, y0: miny, x1: maxx, y1: maxy };

    return { entities: entities, bounds: { x0: minx, y0: miny, x1: maxx, y1: maxy }, rbounds: rb };
  };

  // ---------------------------------------------------- 可见性（AutoCAD 语义）
  // 「关闭」只影响实体自身所在层；「冻结」会沿块参照链向下传播，冻结块参照所在层
  // 会让整个块参照消失（即使块内实体在别的、未冻结的层上）。
  DxfRenderer.prototype.ancFrozen = function (e) {
    var anc = e._anc; if (!anc) return false;
    var ls = this.doc && this.doc.layers; if (!ls) return false;
    for (var i = 0; i < anc.length; i++) {
      var L = ls[anc[i]];
      if (L && L.frozen) return true;
    }
    return false;
  };

  // 是否应当绘制：图层开关取自 visibleLayers（可被用户切回来，与 AutoCAD 一致，
  // 因此不再直接看 doc.layers[].off——那只是文件里的初始状态）
  DxfRenderer.prototype.entVisible = function (e) {
    if (e._degenerate) return false;
    if (e.invisible === 1) return false;
    if (e.layer) {
      if (this.visibleLayers[e.layer] === false) return false;
      var L = this.doc && this.doc.layers[e.layer];
      if (L && L.frozen) return false;
    }
    return !this.ancFrozen(e);
  };

  // ------------------------------------------------------------------ 颜色解析
  // 依次：实体真彩色 -> 实体 ACI(非 0/256) -> 图层真彩色 -> 图层 ACI
  // 注意：BYBLOCK(0) 已在 flatten 阶段就地解析成具体色，这里剩下的 0 只可能是
  // 顶层（无块参照）实体，AutoCAD 视其为当前色，取 7 号色处理。
  DxfRenderer.prototype.colorOf = function (e) {
    if (e._col) return e._col;
    var col = null;
    if (e.trueColor != null) col = DxfParser.trueColor(e.trueColor);
    if (!col && e.color != null && e.color !== 0 && e.color !== 256) col = DxfParser.aciColor(e.color);
    if (!col && e.layer && this.doc && this.doc.layers[e.layer]) {
      var L = this.doc.layers[e.layer];
      if (L.trueColor != null) col = DxfParser.trueColor(L.trueColor);
      if (!col) col = DxfParser.aciColor(L.color);
    }
    if (!col) col = '#FFFFFF';
    e._col = col;
    return col;
  };
  // 兼容旧调用
  DxfRenderer.prototype.setColorOf = function (e) { return this.colorOf(e); };

  // 线型：返回 dash 数组（图形单位），null = 实线
  DxfRenderer.prototype.dashOf = function (e) {
    if (!this.showLinetype || !this.doc) return null;
    var name = e.linetype;
    if (!name || name === 'ByLayer' || name === 'BYLAYER') {
      var L = this.doc.layers[e.layer];
      name = L ? L.linetype : null;
    }
    if (!name || name === 'ByBlock' || name === 'BYBLOCK') return null;
    if (/^continuous$/i.test(name)) return null;
    var lt = this.doc.linetypes[name];
    if (!lt || !lt.dashes || !lt.dashes.length) return null;
    var scl = (this.doc.ltscale || 1) * (e.ltScale || 1);
    var out = [];
    for (var i = 0; i < lt.dashes.length; i++) {
      var d = Math.abs(lt.dashes[i]) * scl;
      out.push(d === 0 ? 0.001 : d);       // 0 = 点，给一个极小长度
    }
    if (out.length % 2) out = out.concat(out);   // 奇数段补成偶数，避免相位错乱
    return out;
  };

  DxfRenderer.prototype.active = function () { return this.spaces[this.currentSpace] || this.spaces['模型']; };
  DxfRenderer.prototype.activeEntities = function () { return (this.active() || { entities: [] }).entities; };

  DxfRenderer.prototype.worldToScreen = function (x, y) {
    var c = this.canvas;
    return { x: (x - this.centerX) * this.scale + c.clientWidth / 2, y: c.clientHeight / 2 - (y - this.centerY) * this.scale };
  };
  DxfRenderer.prototype.screenToWorld = function (sx, sy) {
    var c = this.canvas;
    return { x: (sx - c.clientWidth / 2) / this.scale + this.centerX, y: this.centerY - (sy - c.clientHeight / 2) / this.scale };
  };

  // ---- 视图：三种 AutoCAD 语义 ----
  // 内部：把一个世界包围盒铺满视口
  DxfRenderer.prototype.setViewBox = function (b, margin) {
    if (!b || !isFinite(b.x0) || !isFinite(b.y0) || !isFinite(b.x1) || !isFinite(b.y1)) return false;
    var c = this.canvas;
    var w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!(w > 0) && !(h > 0)) return false;
    if (!(w > 0)) w = h; if (!(h > 0)) h = w;
    var cw = c.clientWidth || 800, ch = c.clientHeight || 600;
    this.scale = Math.min(cw / w, ch / h) * (margin == null ? 0.95 : margin);
    if (!isFinite(this.scale) || this.scale <= 0) return false;
    this.centerX = (b.x0 + b.x1) / 2;
    this.centerY = (b.y0 + b.y1) / 2;
    return true;
  };

  // 打开文件时 AutoCAD 显示的是「上次保存的视图」：$VIEWCTR + $VIEWSIZE（视口高度，图形单位）
  DxfRenderer.prototype.restoreSavedView = function () {
    if (this.currentSpace !== '模型') return false;
    var d = this.doc; if (!d || !d.viewctr || !(d.viewsize > 0)) return false;
    var c = this.canvas, ch = c.clientHeight || 600, cw = c.clientWidth || 800;
    if (!isFinite(d.viewctr.x) || Math.abs(d.viewctr.x) > 1e12) return false;
    this.scale = ch / d.viewsize;                 // VIEWSIZE = 视口在图形单位下的高度
    if (!isFinite(this.scale) || this.scale <= 0) return false;
    this.centerX = d.viewctr.x; this.centerY = d.viewctr.y;
    this.viewMode = 'saved';
    // 稳健性：保存视图必须“真正框住内容”才采用，否则回退 ZOOM EXTENTS 显示出整图。
    // 以前只检查“窗口内有无实体/缩放是否过远”，会让【中心偏离内容】或【仍过远】的过期视图
    // 蒙混过关，导致打开即空白/极小（如某些文件 saved 视图 nb<0.3%）。
    if (!this.savedViewFramesContent()) return false;
    this.render();
    return true;
  };

  // 判断「已设好 center/scale 的保存视图」是否真正把内容框进视口。
  // 关键修正：旧版拿【全局实测范围 extentsBounds】的质心与视图中心比较，但脏图里常有
  // 远离主体的“野坐标”实体（如坐标达数十亿的孤立块），把全局质心拽到极端处，导致
  // AutoCAD 自己保存的、明明正确的视图被误判“中心偏离”而回退 → 打开即空白/极小。
  // 正确做法：直接统计“真正落入该视口窗口内的实体”，用它们的并集包围盒判断框得是否
  // 合适——这正是 AutoCAD 打开时实际呈现的画面。窗口内有内容且占比不过空/不过爆即采用。
  DxfRenderer.prototype.savedViewFramesContent = function () {
    var sp = this.active(); if (!sp) return true;          // 无法判定时保守采用
    var c = this.canvas, cw = c.clientWidth || 800, ch = c.clientHeight || 600;
    if (!(this.scale > 0)) return true;
    var d = this.doc;
    var halfW = (cw / 2) / this.scale, halfH = (ch / 2) / this.scale;
    var vx0 = this.centerX - halfW, vx1 = this.centerX + halfW;
    var vy0 = this.centerY - halfH, vy1 = this.centerY + halfH;
    // 遍历实体，收集“包围盒与视口相交”者，计算其并集包围盒与数量
    var ents = sp.entities, ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity, n = 0;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      var L = d && d.layers[e.layer];
      if (L && L.frozen) continue;
      if (this.ancFrozen(e)) continue;
      var b = e._bb; if (!b) continue;
      if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue; // 与视口不相交
      if (b.x0 < ix0) ix0 = b.x0; if (b.x1 > ix1) ix1 = b.x1;
      if (b.y0 < iy0) iy0 = b.y0; if (b.y1 > iy1) iy1 = b.y1;
      n++;
    }
    if (n === 0) return false;                            // 视口内一个实体都没有 → 过期空视图
    // 实体占比门槛：保存视图必须是“全图概览”而非某个细节放大。
    // 若窗口内实体数仅占全图的极小比例（如仅若干“意见修改”批注），说明这是局部放大/批注视图，
    // AutoCAD 打开时显示的是整图，继续采用会让画面几乎空白 → 回退 ZOOM EXTENTS 显示整图。
    var totalN = ents.length || 1;
    if (n < 20 || n / totalN < 0.01) return false;
    var iw = ix1 - ix0, ih = iy1 - iy0;
    if (!(iw > 0) || !(ih > 0)) return false;
    var fillX = iw * this.scale / cw, fillY = ih * this.scale / ch;
    var fill = Math.min(fillX, fillY);
    if (fill < 0.10) return false;                       // 内容只占屏幕 <10% → 过远/过空，回退
    if (fill > 8.0) return false;                        // 内容撑爆屏幕 >8 倍 → 离谱放大，回退
    return true;
  };

  // AutoCAD 语义：ZOOM EXTENTS 忽略【冻结】图层上的对象，但仍包含【关闭】图层上的对象
  DxfRenderer.prototype.extentsBounds = function () {
    var sp = this.active(); if (!sp) return null;
    var d = this.doc, ents = sp.entities;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      var L = d && d.layers[e.layer];
      if (L && L.frozen) continue;                 // 冻结层不参与 ZOOM E
      if (this.ancFrozen(e)) continue;             // 块参照所在层被冻结 → 整块不参与
      var b = e._bb; if (!b) continue;
      if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
      n++;
    }
    return n ? { x0: x0, y0: y0, x1: x1, y1: y1, count: n } : null;
  };

  // ZOOM EXTENTS：全部可见实体的真实范围（与 AutoCAD 的 ZOOM E 等价）
  DxfRenderer.prototype.zoomExtents = function () {
    var sp = this.active(); if (!sp) return;
    var b = this.extentsBounds() || sp.bounds;
    // 关键：AutoCAD 的 ZOOM EXTENTS 基于"实际实体几何"，并不使用 HEADER 的 $EXTMIN/$EXTMAX
    // —— 后者是"数据库范围"，常含原点处的孤立定义点/尺寸夹点/过期值。一旦并入会把真图
    // 撑成亚像素（已实测：某图 HEADER 含 (0.0157,-0.0667) 的原点点，使整图缩成 1px）。
    // 因此只用实测实体范围；仅当实测范围为空时才回退 HEADER。
    if ((!b || (!((b.x1 - b.x0) > 0) && !((b.y1 - b.y0) > 0))) &&
        this.currentSpace === '模型' && this.doc && this.doc.extmin && this.doc.extmax) {
      var e0 = this.doc.extmin, e1 = this.doc.extmax;
      if (isFinite(e0.x) && isFinite(e1.x) && e1.x > e0.x && e1.y > e0.y && Math.abs(e0.x) < 1e12) {
        b = { x0: e0.x, y0: e0.y, x1: e1.x, y1: e1.y };
      }
    }
    if (!b) b = sp.rbounds;
    if (this.setViewBox(b, 0.95)) { this.viewMode = 'extents'; this.render(); }
  };

  // ZOOM 到密集区（稳健百分位）——处理有远离孤立实体的脏图
  DxfRenderer.prototype.zoomDense = function () {
    var sp = this.active(); if (!sp) return;
    if (this.setViewBox(sp.rbounds || sp.bounds, 0.95)) { this.viewMode = 'dense'; this.render(); }
  };

  // 思源嵌入/侧栏模式下，保证首次 fit 后最小文字可读。
  // 单机 index.html 大窗口 fit 后文字自然可读；思源 480px 小视口 fit 后文字常缩成 3px 以下，
  // 因此按最小文字实体的高度自动提升 scale（上限 2.5 倍），让默认视图字体像素高度接近单机。
  DxfRenderer.prototype._ensureReadableText = function () {
    var sp = this.active(); if (!sp || !sp.entities) return;
    var minH = Infinity;
    for (var i = 0; i < sp.entities.length; i++) {
      var e = sp.entities[i];
      if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB') {
        var h = Math.abs(this._resolveTextHeight(e));
        if (h > 0 && h < minH) minH = h;
      }
    }
    if (!isFinite(minH) || minH <= 0) return;
    // 分别保证系统字体和 SHX 在思源小视口里达到可读像素高度。
    // SHX 描边在 <12px 时会回退系统字体，这里按 SHX 自身 textScaleShx=4 计算，
    // 确保默认打开时 SHX 的真实像素高度接近单机 HTML 大窗口。
    var s = this.scale, targets = [
      { scale: this.textScaleSys, target: 8 },   // 系统字体/中文：8px 可读
      { scale: this.textScaleShx, target: 20 }   // SHX：20px 以上笔画比例正常，思源小视口首屏更清晰
    ];
    var needBoost = 1;
    for (var ti = 0; ti < targets.length; ti++) {
      var t = targets[ti];
      var currentPx = minH * s * t.scale;
      if (currentPx < t.target) {
        var boost = t.target / currentPx;
        if (boost > needBoost) needBoost = boost;
      }
    }
    if (needBoost > 1) {
      this.scale *= Math.min(needBoost, 5);   // 最多放大 5 倍，避免极端图全屏只剩几个字
    }
  };

  // fit()：默认行为 = 尽量还原 AutoCAD 打开时的画面
  DxfRenderer.prototype.fit = function () {
    var sp = this.active();
    if (sp && sp.isPaper) { this.fitPaper(); return; }
    if (this.restoreSavedView()) return;
    // 保存视图无效时：若实测范围与稳健范围差异巨大（>8 倍），说明有孤立远点，用密集区更接近可用画面
    if (sp && sp.bounds && sp.rbounds) {
      var wa = sp.bounds.x1 - sp.bounds.x0, wr = sp.rbounds.x1 - sp.rbounds.x0;
      if (wr > 0 && wa / wr > 8) { this.zoomDense(); return; }
    }
    this.zoomExtents();
    // 思源=单机：embed/dock 视图不再做文字放大 boost，fit 行为与单机 index.html 完全一致，
    // 文字随视图比例缩放，和几何图形保持同一比例。boostTextInEmbed=true 时才会启用旧的可读性增强。
    if (this.embedMode && this.boostTextInEmbed) this._ensureReadableText();
  };

  // 图纸空间适配：铺满整张纸
  DxfRenderer.prototype.fitPaper = function () {
    var sp = this.active(); if (!sp) return;
    var sheet = this._paperSheetRect(sp);
    if (sheet && isFinite(sheet.x0) && (sheet.x1 - sheet.x0) > 0 && (sheet.y1 - sheet.y0) > 0) {
      if (this.setViewBox(sheet, 0.9)) { this.viewMode = 'paper'; this.render(); return; }
    }
    var b = (sp.bounds && isFinite(sp.bounds.x0) && (sp.bounds.x1 - sp.bounds.x0) > 0) ? sp.bounds : { x0: 0, y0: 0, x1: 841, y1: 594 };
    if (this.setViewBox(b, 0.9)) { this.viewMode = 'paper'; this.render(); }
  };

  DxfRenderer.prototype.pan = function (dxScreen, dyScreen) {
    this.centerX -= dxScreen / this.scale; this.centerY += dyScreen / this.scale; this.render();
  };
  DxfRenderer.prototype.zoom = function (factor, cx, cy) {
    if (cx == null) { cx = this.canvas.clientWidth / 2; cy = this.canvas.clientHeight / 2; }
    var before = this.screenToWorld(cx, cy);
    this.scale *= factor;
    if (this.scale < 1e-9) this.scale = 1e-9;
    if (this.scale > 1e9) this.scale = 1e9;
    var after = this.screenToWorld(cx, cy);
    this.centerX += before.x - after.x; this.centerY += before.y - after.y;
    this.render();
  };
  DxfRenderer.prototype.viewBounds = function () {
    var c = this.canvas;
    var tl = this.screenToWorld(0, 0), br = this.screenToWorld(c.clientWidth, c.clientHeight);
    return { x0: Math.min(tl.x, br.x), y0: Math.min(tl.y, br.y), x1: Math.max(tl.x, br.x), y1: Math.max(tl.y, br.y) };
  };

  // ---------------------------------------------------------------- 包围盒
  function arcBBox(cx, cy, r, a0, a1) {
    // a0/a1 度，逆时针
    var s = a0 * D2R, e = a1 * D2R;
    while (e <= s) e += TAU;
    var xs = [cx + r * Math.cos(s), cx + r * Math.cos(e)];
    var ys = [cy + r * Math.sin(s), cy + r * Math.sin(e)];
    for (var k = 0; k < 4; k++) {
      var a = k * Math.PI / 2;
      var aa = a; while (aa < s) aa += TAU;
      if (aa <= e) { xs.push(cx + r * Math.cos(aa)); ys.push(cy + r * Math.sin(aa)); }
    }
    return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
  }

  function bbox(e, self) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    function add(x, y) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    if (e.type === 'CIRCLE') {
      if (!e.points[0]) return null;
      var r = Math.abs(e.r40 || 0);
      add(e.points[0].x - r, e.points[0].y - r); add(e.points[0].x + r, e.points[0].y + r);
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }
    if (e.type === 'ARC') {
      if (!e.points[0]) return null;
      return arcBBox(e.points[0].x, e.points[0].y, Math.abs(e.r40 || 0), e.a50 || 0, e.a51 || 0);
    }
    if (e.type === 'ELLIPSE') {
      if (!e.points[0]) return null;
      var mj = e.points[1] || { x: e.r40 || 1, y: 0 };
      var ra = Math.hypot(mj.x, mj.y), rb = ra * (e.ratio != null ? e.ratio : 1);
      var rr = Math.max(ra, rb);
      add(e.points[0].x - rr, e.points[0].y - rr); add(e.points[0].x + rr, e.points[0].y + rr);
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }
    // MTEXT 的 points[1] 是 group 11（X 轴方向向量，相对量），ELLIPSE 的 points[1]
    // 是相对长轴向量——二者都不是坐标顶点，若当绝对顶点会把范围撑到数十亿单位，
    // 污染 ZOOM EXTENTS。它们已由各自的专用分支（半径）处理。TEXT/ATTRIB 的
    // points[1] 是真实对齐点（绝对坐标），须保留。
    if (e.points) for (var i = 0; i < e.points.length; i++) {
      if (i === 1 && (e.type === 'MTEXT' || e.type === 'ELLIPSE')) continue;
      var p = e.points[i]; if (p) add(p.x, p.y);
    }
    if (e.vertices) for (var v = 0; v < e.vertices.length; v++) add(e.vertices[v].x, e.vertices[v].y);
    if (e.ctrl) for (var c = 0; c < e.ctrl.length; c++) add(e.ctrl[c].x, e.ctrl[c].y);
    if (e.fit) for (var f = 0; f < e.fit.length; f++) add(e.fit[f].x, e.fit[f].y);
    if (e.boundaryLoops) for (var L = 0; L < e.boundaryLoops.length; L++) {
      var lp = e.boundaryLoops[L];
      if (lp.vertices) for (var w = 0; w < lp.vertices.length; w++) add(lp.vertices[w].x, lp.vertices[w].y);
      if (lp.edges) for (var E = 0; E < lp.edges.length; E++) {
        var ed = lp.edges[E]; if (!ed) continue;
        if (ed.kind === 'line') { add(ed.x1 || 0, ed.y1 || 0); add(ed.x2 || 0, ed.y2 || 0); }
        else if (ed.cx != null) { var er = Math.abs(ed.r || Math.hypot(ed.mx || 0, ed.my || 0) || 0); add(ed.cx - er, ed.cy - er); add(ed.cx + er, ed.cy + er); }
        else if (ed.ctrl) for (var sc = 0; sc < ed.ctrl.length; sc++) add(ed.ctrl[sc].x, ed.ctrl[sc].y);
      }
    }
    // 文字：粗略按字高与字数估计，保证不被视口剔除误杀
    if ((e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB') && e.points[0]) {
      var hh = Math.abs(self && self._resolveTextHeight ? self._resolveTextHeight(e) : (e.r40 || 2.5));
      var len = String(e.text || '').length || 1;
      add(e.points[0].x - hh, e.points[0].y - hh);
      add(e.points[0].x + hh * len, e.points[0].y + hh * 1.5);
    }
    if (x0 === Infinity) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  // ---------------------------------------------------------------- 主绘制
  DxfRenderer.prototype.render = function () {
    var c = this.canvas;
    // 关键修正：不能用 c.clientWidth/clientHeight，因为 canvas 的 CSS 尺寸可能被上一帧错误值
    // “钉死”（JS 显式设置 style.width/height 后，即使父容器缩小，c.clientHeight 仍会保持旧值）。
    // 必须从父容器（#stage）读取尺寸，这样 canvas 始终与 stage 同步，不会溢出到底部状态栏。
    var stage = c.parentElement;
    var W = stage ? stage.clientWidth : c.clientWidth;
    var H = stage ? stage.clientHeight : c.clientHeight;
    if (!W || !H) { W = stage ? (stage.clientWidth || 1) : (c.clientWidth || 1); H = stage ? (stage.clientHeight || 1) : (c.clientHeight || 1); }
    // dpr 运行时动态读取：思源内 iframe 可能晚于主窗口布局、或在多屏/缩放切换后 devicePixelRatio 变化，
    // 一次性在构造时缓存的 dpr 会失真（位图分辨率不对 → 文字/细线发虚）。这里每次渲染都用最新值。
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || this.dpr || 1;
    this.dpr = dpr;
    // 强制同步显示 canvas 的位图尺寸与 CSS 尺寸：思源 iframe 尺寸变化时，app.js 的 resize()
    // 可能没触发（iframe 自身 window.resize 不响应父文档布局变化），导致 canvas 属性还是旧值。
    // _blitOffscreen 按当前 W,H,dpr 清/画，若与 canvas 位图大小不一致，就会只更新一部分、底部残影。
    // 每帧无条件同步 canvas 位图尺寸与 CSS 尺寸。思源里父文档布局/外观缩放变化可能让
    // clientWidth/Height 在 resize 事件之外悄悄改变，若只在尺寸“变化”时才重设，
    // 一旦读到错误值就会沿用旧位图，导致 _blitOffscreen 只清/画部分像素、底部/边缘残影。
    // 每帧重设 c.width/height（浏览器会自动清空）可彻底杜绝该问题；重设后立即重绘，无副作用。
    var needW = Math.max(1, Math.round(W * dpr));
    var needH = Math.max(1, Math.round(H * dpr));
    c.width = needW; c.height = needH;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    var ov = c.parentNode && c.parentNode.querySelector ? c.parentNode.querySelector('#overlay') : null;
    if (ov) { ov.width = needW; ov.height = needH; ov.style.width = W + 'px'; ov.style.height = H + 'px'; }
    // 2x 超采样：在 2 倍设备分辨率的离屏 canvas 上绘制，再线性缩放回显示 canvas。
    // 这样细斜线在 zoom/pan 时的子像素覆盖率变化被多子像素平均，不再在「灰↔白」间跳变。
    var ss = 2;
    if (!this._offCanvas) {
      this._offCanvas = document.createElement('canvas');
      this._offCtx = this._offCanvas.getContext('2d');
    }
    var offW = Math.max(1, Math.floor(W * dpr * ss));
    var offH = Math.max(1, Math.floor(H * dpr * ss));
    if (this._offCanvas.width !== offW || this._offCanvas.height !== offH) {
      this._offCanvas.width = offW;
      this._offCanvas.height = offH;
    }
    var ctx = this._offCtx;
    ctx.setTransform(dpr * ss, 0, 0, dpr * ss, 0, 0);
    ctx.fillStyle = this.bgColor || '#000';
    ctx.fillRect(0, 0, W, H);
    var sp = this.active(); if (!sp) { this._blitOffscreen(); return; }

    var vb = this.viewBounds();
    var s = this.scale, cxw = this.centerX, cyw = this.centerY;
    var offX = W / 2 - cxw * s, offY = H / 2 + cyw * s;
    // 屏幕坐标：X = x*s + offX ; Y = offY - y*s
    var self = this;
    function SX(x) { return x * s + offX; }
    function SY(y) { return offY - y * s; }

    // 图纸空间（布局）：白纸底 + 逐视口裁剪绘制模型内容 + 图纸空间实体
    if (sp.isPaper) {
      this._renderPaper(ctx, s, offX, offY);
      this._drawSnap(ctx, SX, SY);
      if (this.onView) this.onView();
      this._blitOffscreen();
      return;
    }

    var ents = sp.entities;
    var vis = [];
    var doc = this.doc;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      if (e.invisible === 1) continue;
      var bb = e._bb;
      if (bb && (bb.x1 < vb.x0 || bb.x0 > vb.x1 || bb.y1 < vb.y0 || bb.y0 > vb.y1)) continue;
      if (e.layer) {
        if (this.visibleLayers[e.layer] === false) continue;
        var L = doc && doc.layers[e.layer];
        if (L && L.frozen) continue;
      }
      if (e._anc && this.ancFrozen(e)) continue;    // 冻结沿块参照链传播
      // 不按"亚像素"剔除实体：AutoCAD 在 ZOOM EXTENTS 大坐标(如带地理坐标 y≈4.3e9)下
      // 仍会绘制亚像素实体，整图呈现为可见小簇而非空白。原先的亚像素剔除会把带地理
      // 坐标的图纸整图变空白（scale≈1e-6 时所有实体都 <0.35px 而被跳过）。
      // 仅跳过真正退化的零面积包围盒（POINT/零长实体本就无面积）。
      if (bb && (bb.x1 < bb.x0 || bb.y1 < bb.y0)) continue;
      vis.push(e);
    }

    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 1;

    // 按空间裁剪矩形（_clip）分组；同一 INSERT 产生的裁剪区相同，可共享一次 canvas clip。
    // 这样被 XCLIP 裁切的实体在边界处会被硬裁，与 AutoCAD 一致。
    var groups = [], groupMap = {};
    for (var i = 0; i < vis.length; i++) {
      var e = vis[i];
      var key = e._clip ? (e._clip.minx + '|' + e._clip.miny + '|' + e._clip.maxx + '|' + e._clip.maxy) : '';
      var g = groupMap[key];
      if (!g) { g = { clip: e._clip || null, ents: [] }; groupMap[key] = g; groups.push(g); }
      g.ents.push(e);
    }
    // 先绘制所有几何（填充+线），并收集各裁剪区内的文字，最后统一绘制文字，
    // 确保文字不会被其他几何遮挡。
    var textGroups = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      ctx.save();
      if (g.clip) {
        ctx.beginPath();
        ctx.rect(SX(g.clip.minx), SY(g.clip.maxy), SX(g.clip.maxx) - SX(g.clip.minx), SY(g.clip.miny) - SY(g.clip.maxy));
        ctx.clip();
      }
      var txts = this._drawEntityList(ctx, g.ents, s, SX, SY, { skipText: true });
      ctx.restore();
      if (txts && txts.length) textGroups.push({ clip: g.clip, texts: txts });
    }
    // 文字全局置顶绘制（仍尊重各自的 XCLIP 裁剪区）
    for (var ti = 0; ti < textGroups.length; ti++) {
      var tg = textGroups[ti];
      ctx.save();
      if (tg.clip) {
        ctx.beginPath();
        ctx.rect(SX(tg.clip.minx), SY(tg.clip.maxy), SX(tg.clip.maxx) - SX(tg.clip.minx), SY(tg.clip.miny) - SY(tg.clip.maxy));
        ctx.clip();
      }
      for (var tx = 0; tx < tg.texts.length; tx++) this._drawText(ctx, tg.texts[tx], s, SX, SY);
      ctx.restore();
    }

    // 选中高亮
    if (this.selected >= 0 && ents[this.selected]) this._strokeSelect(ctx, ents[this.selected], s, SX, SY);

    this._drawOverlays(ctx, s, SX, SY);

    if (this.snapPoint) {
      var qx = SX(this.snapPoint.x), qy = SY(this.snapPoint.y);
      ctx.save(); ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 1.5;
      ctx.strokeRect(qx - 5, qy - 5, 10, 10);
      ctx.restore();
    }
    if (this.onView) this.onView();
    this._blitOffscreen();
  };

  // 把离屏超采样结果缩放回显示 canvas
  DxfRenderer.prototype._blitOffscreen = function () {
    var dst = this.ctx;
    var c = this.canvas;
    // 用 canvas 自身位图尺寸清/画，避免 W/H（CSS 像素）与当前 dpr/transform 不匹配时
    // 只清了一部分、底部/右侧残留旧帧。
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.clearRect(0, 0, c.width, c.height);
    // 必须取完整离屏 canvas 再缩回显示 canvas；旧代码用 (0,0,c.width,c.height) 只取了 2x 超采样图的 1/4，
    // 导致画面被错误放大并只显示左上角，同时四周/底部可能露出未覆盖的旧帧。
    var off = this._offCanvas;
    dst.drawImage(off, 0, 0, off.width, off.height, 0, 0, c.width, c.height);
  };

  // ---------------------------------------------------------------- 实体列表：填充 + 线 + 文字（按同一空间裁剪矩形分组）
  // opts.skipText=true 时只绘制几何，不绘制文字，并把文字实体数组返回供调用方统一最后绘制。
  DxfRenderer.prototype._drawEntityList = function (ctx, list, s, SX, SY, opts) {
    opts = opts || {};
    // 第 1 遍：填充
    for (var f = 0; f < list.length; f++) {
      var ef = list[f];
      if (ef.type === 'HATCH') this._drawHatch(ctx, ef, s, SX, SY);
      else if (ef.type === 'SOLID' || ef.type === 'TRACE' || ef.type === '3DFACE') this._drawSolid(ctx, ef, SX, SY);
      else if (this._isFillablePoly(ef)) this._fillPoly(ctx, ef, s, SX, SY);
    }

    // 第 2 遍：线（按 颜色+线型 分组批量成路径，一次描边）
    var batches = {}, texts = [];
    for (var k = 0; k < list.length; k++) {
      var e2 = list[k];
      var t = e2.type;
      if (t === 'HATCH' || t === 'SOLID' || t === 'TRACE' || t === '3DFACE') continue;
      if (this._isFillablePoly(e2)) continue;   // 已在第 1 遍填充，避免再画中心线
      if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB') { texts.push(e2); continue; }
      var col = this.colorOf(e2);
      var dash = this.dashOf(e2);
      var dashPx = null;
      if (dash) {
        dashPx = [];
        var sum = 0;
        for (var d = 0; d < dash.length; d++) { var px = dash[d] * s; dashPx.push(px); sum += px; }
        if (sum < 2.5) dashPx = null;
        else if (e2._bb) {
          var diagPx = Math.hypot(e2._bb.x1 - e2._bb.x0, e2._bb.y1 - e2._bb.y0) * s;
          if (diagPx <= sum) dashPx = null;
        }
      }
      var key = col + '|' + (dashPx ? dashPx.map(function (v) { return v.toFixed(2); }).join(',') : '');
      var bt = batches[key];
      if (!bt) { bt = batches[key] = { color: col, dash: dashPx, path: new Path2D() }; }
      this._pathEntity(bt.path, e2, s, SX, SY);
    }
    for (var kk in batches) {
      var B = batches[kk];
      ctx.strokeStyle = B.color;
      if (B.dash) ctx.setLineDash(B.dash); else ctx.setLineDash([]);
      ctx.stroke(B.path);
    }
    ctx.setLineDash([]);

    if (opts.skipText) return texts;

    // 第 3 遍：文字（与几何同裁剪区；调用方如需全局置顶，应使用 skipText+二次绘制）
    for (var tx = 0; tx < texts.length; tx++) this._drawText(ctx, texts[tx], s, SX, SY);
  };

  // ---------------------------------------------------------------- 实体批量绘制（模型 / 视口共用）
  // opts: { viewBounds(世界裁剪框), frozenOverride(图层->是否冻结) }
  DxfRenderer.prototype._drawEntities = function (ctx, ents, s, offX, offY, opts) {
    opts = opts || {};
    var self = this, doc = this.doc;
    var vb = opts.viewBounds || self.viewBounds();
    function SX(x) { return x * s + offX; }
    function SY(y) { return offY - y * s; }

    var vis = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      if (e.invisible === 1) continue;
      var bb = e._bb;
      if (bb && (bb.x1 < vb.x0 || bb.x0 > vb.x1 || bb.y1 < vb.y0 || bb.y0 > vb.y1)) continue;
      if (e.layer) {
        if (this.visibleLayers[e.layer] === false) continue;
        var L = doc && doc.layers[e.layer];
        if (L && L.frozen) continue;
      }
      if (e._anc && this.ancFrozen(e)) continue;
      if (bb && (bb.x1 < bb.x0 || bb.y1 < bb.y0)) continue;
      vis.push(e);
    }

    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 1;

    // 按空间裁剪矩形（_clip）分组；同一 INSERT 产生的裁剪区相同，可共享一次 canvas clip。
    var groups = [], groupMap = {};
    for (var i = 0; i < vis.length; i++) {
      var e = vis[i];
      var key = e._clip ? (e._clip.minx + '|' + e._clip.miny + '|' + e._clip.maxx + '|' + e._clip.maxy) : '';
      var g = groupMap[key];
      if (!g) { g = { clip: e._clip || null, ents: [] }; groupMap[key] = g; groups.push(g); }
      g.ents.push(e);
    }
    // 几何先绘制，文字统一后绘制，避免被填充/线条遮挡。
    var textGroups = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      ctx.save();
      if (g.clip) {
        ctx.beginPath();
        ctx.rect(SX(g.clip.minx), SY(g.clip.maxy), SX(g.clip.maxx) - SX(g.clip.minx), SY(g.clip.miny) - SY(g.clip.maxy));
        ctx.clip();
      }
      var txts = this._drawEntityList(ctx, g.ents, s, SX, SY, { skipText: true });
      ctx.restore();
      if (txts && txts.length) textGroups.push({ clip: g.clip, texts: txts });
    }
    for (var ti = 0; ti < textGroups.length; ti++) {
      var tg = textGroups[ti];
      ctx.save();
      if (tg.clip) {
        ctx.beginPath();
        ctx.rect(SX(tg.clip.minx), SY(tg.clip.maxy), SX(tg.clip.maxx) - SX(tg.clip.minx), SY(tg.clip.miny) - SY(tg.clip.maxy));
        ctx.clip();
      }
      for (var tx = 0; tx < tg.texts.length; tx++) this._drawText(ctx, tg.texts[tx], s, SX, SY);
      ctx.restore();
    }
  };

  DxfRenderer.prototype._drawSnap = function (ctx, SX, SY) {
    if (!this.snapPoint) return;
    var qx = SX(this.snapPoint.x), qy = SY(this.snapPoint.y);
    ctx.save(); ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 1.5;
    ctx.strokeRect(qx - 5, qy - 5, 10, 10);
    ctx.restore();
  };

  DxfRenderer.prototype.modelEntities = function () {
    var m = this.spaces['模型'];
    return m ? m.entities : [];
  };

  // 给定实体列表的几何范围（忽略退化），用于视口/适配
  DxfRenderer.prototype._boundsOf = function (ents) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i]; if (e._degenerate) continue;
      var b = e._bb; if (!b) continue;
      if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1; n++;
    }
    return n ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
  };

  // 视口模型视图变换：把模型内容放进视口矩形（默认按范围适配；比例未知时即 "ZOOM 适配"）
  DxfRenderer.prototype._vpModelTransform = function (vp, modelEnts, vcx, vcy, w, h) {
    if (!modelEnts || !modelEnts.length) return null;
    var b = this._boundsOf(modelEnts);
    if (!b) return null;
    var mcx = (vp.vcx != null && isFinite(vp.vcx)) ? vp.vcx : (b.x0 + b.x1) / 2;
    var mcy = (vp.vcy != null && isFinite(vp.vcy)) ? vp.vcy : (b.y0 + b.y1) / 2;
    var mw = (b.x1 - b.x0) || 1, mh = (b.y1 - b.y0) || 1;
    var ms = Math.min(w / mw, h / mh) * 0.96;
    if (!(ms > 0) || !isFinite(ms)) return null;
    var hw = (w / ms) / 2, hh = (h / ms) / 2;
    return {
      scale: ms, cx: mcx, cy: mcy,
      bounds: { x0: mcx - hw, y0: mcy - hh, x1: mcx + hw, y1: mcy + hh }
    };
  };

  // 图纸尺寸矩形（图纸坐标 = 世界坐标）。优先用 LAYOUT 对象里的打印范围/界限
  DxfRenderer.prototype._paperSheetRect = function (sp) {
    var L = this.doc && this.doc.layouts[this.currentSpace];
    if (L && L.paperMin && L.paperMax && isFinite(L.paperMin.x) && (L.paperMax.x - L.paperMin.x) > 0)
      return { x0: L.paperMin.x, y0: L.paperMin.y, x1: L.paperMax.x, y1: L.paperMax.y };
    if (L && L.limMin && L.limMax && isFinite(L.limMin.x) && (L.limMax.x - L.limMin.x) > 0)
      return { x0: L.limMin.x, y0: L.limMin.y, x1: L.limMax.x, y1: L.limMax.y };
    if (sp.bounds && isFinite(sp.bounds.x0) && (sp.bounds.x1 - sp.bounds.x0) > 0) return sp.bounds;
    return { x0: 0, y0: 0, x1: 841, y1: 594 };   // 默认 A1
  };

  // 图纸空间渲染：白纸底 + 逐视口裁剪绘制模型 + 图纸空间实体
  DxfRenderer.prototype._renderPaper = function (ctx, s, offX, offY) {
    var sp = this.active();
    if (!sp) return;
    var W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    function SX(x) { return x * s + offX; }
    function SY(y) { return offY - y * s; }

    // 1) 白纸底
    var sheet = this._paperSheetRect(sp);
    if (sheet) {
      var sx = SX(sheet.x0), sy = SY(sheet.y1);
      var sw = (sheet.x1 - sheet.x0) * s, sh = (sheet.y1 - sheet.y0) * s;
      ctx.save();
      ctx.fillStyle = '#f5f5f1';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = '#777'; ctx.lineWidth = 1;
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.restore();
    }

    // 2) 逐个视口：裁剪到视口矩形，绘制模型空间内容
    var modelEnts = this.modelEntities();
    var vps = sp.viewports || [];
    for (var vi = 0; vi < vps.length; vi++) {
      var vp = vps[vi];
      if (vp.status === -1) continue;
      if (!(vp.w > 0) || !(vp.h > 0)) continue;
      var halfW = vp.w / 2, halfH = vp.h / 2;
      var x0 = SX(vp.cx - halfW), y0 = SY(vp.cy + halfH);
      var w = vp.w * s, h = vp.h * s;
      var vcx = x0 + w / 2, vcy = y0 + h / 2;
      var mInfo = this._vpModelTransform(vp, modelEnts, vcx, vcy, w, h);
      if (!mInfo) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x0, y0, w, h);
      if (vp.twist) { ctx.translate(vcx, vcy); ctx.rotate(-vp.twist * Math.PI / 180); ctx.translate(-vcx, -vcy); }
      var ms = mInfo.scale, moffX = vcx - mInfo.cx * ms, moffY = vcy + mInfo.cy * ms;
      this._drawEntities(ctx, modelEnts, ms, moffX, moffY, { viewBounds: mInfo.bounds });
      ctx.restore();
    }

    // 3) 图纸空间实体（标题栏、边框、注释）不裁剪，直接绘于白纸之上
    this._drawEntities(ctx, sp.entities, s, offX, offY, {});
  };

  // 把图纸块里的 VPORT 实体抽成视口参数
  DxfRenderer.prototype._extractViewports = function (blockEntities) {
    var out = [];
    if (!blockEntities) return out;
    for (var i = 0; i < blockEntities.length; i++) {
      var e = blockEntities[i];
      if (e.type !== 'VPORT') continue;
      var c = e.points && e.points[0];
      var vc = e.points && e.points[2];
      out.push({
        cx: c ? c.x : 0, cy: c ? c.y : 0,
        w: Math.abs(e.r40 || 0), h: Math.abs(e.r41 || 0),
        vcx: vc ? vc.x : null, vcy: vc ? vc.y : null,
        twist: e.r51 || e.a51 || 0, status: (e.status != null ? e.status : 1)
      });
    }
    return out;
  };

  // 把实体几何加到 Path2D（不描边）
  DxfRenderer.prototype._pathEntity = function (P, e, s, SX, SY) {
    // 发丝线（1px 描边）吸附到【设备像素】中心：避免线居中在整数设备像素时横跨两像素各 50%
    // 而渲染成约 50% 灰、随 zoom/pan 在「灰(看不见)↔纯白(清晰)」间闪烁（白线随 zoom 显隐）。
    // 关键：画布用 setTransform(dpr,...) 缩放，故必须按 dpr 把坐标对齐到【真实设备像素】中心，
    // 仅对 CSS 像素做 round+0.5 在 Windows 125%/150% 缩放(dpr=1.25/1.5)下仍会跨设备像素而闪烁。
    var _sx = SX, _sy = SY;
    var dpr = this.dpr || 1;
    SX = function (x) { return Math.round(_sx(x) * dpr) / dpr + 0.5 / dpr; };
    SY = function (y) { return Math.round(_sy(y) * dpr) / dpr + 0.5 / dpr; };
    switch (e.type) {
      case 'LINE': {
        var p = e.points; if (!p[0] || !p[1]) return;
        P.moveTo(SX(p[0].x), SY(p[0].y)); P.lineTo(SX(p[1].x), SY(p[1].y));
        return;
      }
      case 'LWPOLYLINE': case 'POLYLINE': this._pathPoly(P, e, s, SX, SY); return;
      case 'CIRCLE': {
        if (!e.points[0]) return;
        var r = Math.abs((e.r40 || 0) * s); if (r < 0.2) return;
        P.moveTo(SX(e.points[0].x) + r, SY(e.points[0].y));
        P.arc(SX(e.points[0].x), SY(e.points[0].y), r, 0, TAU);
        return;
      }
      case 'ARC': {
        if (!e.points[0]) return;
        var rr = Math.abs((e.r40 || 0) * s); if (rr < 0.2) return;
        var a0 = (e.a50 || 0), a1 = (e.a51 || 0);
        while (a1 <= a0) a1 += 360;
        // 世界逆时针 [a0,a1] => 屏幕角 [-a1,-a0] 正向
        var sx0 = SX(e.points[0].x), sy0 = SY(e.points[0].y);
        P.moveTo(sx0 + rr * Math.cos(-a1 * D2R), sy0 + rr * Math.sin(-a1 * D2R));
        P.arc(sx0, sy0, rr, -a1 * D2R, -a0 * D2R, false);
        return;
      }
      case 'ELLIPSE': this._pathEllipse(P, e, s, SX, SY); return;
      case 'SPLINE': this._pathSpline(P, e, s, SX, SY); return;
      case 'POINT': {
        // Defpoints 层是尺寸/引线定义点层：商业 CAD（AutoCAD/GstarCAD）默认不显示，
        // 网页端对齐跳过，避免满屏"像素点"噪点（本图约 3128 个此类 POINT）。
        if (e.layer && /^defpoints$/i.test(e.layer)) return;
        if (!e.points[0]) return;
        var px = SX(e.points[0].x), py = SY(e.points[0].y);
        P.moveTo(px - 1.5, py); P.lineTo(px + 1.5, py); P.moveTo(px, py - 1.5); P.lineTo(px, py + 1.5);
        return;
      }
      case 'LEADER': {
        var vs = e.vertices; if (!vs || vs.length < 2) return;
        P.moveTo(SX(vs[0].x), SY(vs[0].y));
        for (var i = 1; i < vs.length; i++) P.lineTo(SX(vs[i].x), SY(vs[i].y));
        return;
      }
    }
  };

  DxfRenderer.prototype._pathPoly = function (P, e, s, SX, SY) {
    var pts = e.vertices && e.vertices.length ? e.vertices : e.points;
    if (!pts || !pts.length) return;
    var closed = !!(e.f70 & 1);      // 只有 70&1 才闭合（LWPOLYLINE 与 POLYLINE 同）
    P.moveTo(SX(pts[0].x), SY(pts[0].y));
    for (var i = 1; i < pts.length; i++) {
      if (pts[i - 1].bulge) this._pathBulge(P, pts[i - 1], pts[i], s, SX, SY);
      else P.lineTo(SX(pts[i].x), SY(pts[i].y));
    }
    if (closed && pts.length > 2) {
      var last = pts[pts.length - 1];
      if (last.bulge) this._pathBulge(P, last, pts[0], s, SX, SY);
      else P.lineTo(SX(pts[0].x), SY(pts[0].y));
    }
  };

  // 闭合宽多段线：AutoCAD FILLMODE 下会把内部填充成实体色（如电气设备块）。
  // 判定条件：闭合（f70&1、首尾重合、或首点在后面某顶点重现形成回路）且宽度 > 0。
  DxfRenderer.prototype._isWideClosedPoly = function (e) {
    if (e.type !== 'LWPOLYLINE' && e.type !== 'POLYLINE') return false;
    var pts = e.vertices && e.vertices.length ? e.vertices : e.points;
    if (!pts || pts.length < 3) return false;
    var closed = !!(e.f70 & 1);
    if (!closed) {
      var first = pts[0], last = pts[pts.length - 1];
      closed = first && last && Math.hypot(first.x - last.x, first.y - last.y) < 1e-8;
      if (!closed && first) {
        for (var j = 1; j < pts.length; j++) {
          var pj = pts[j];
          if (Math.hypot(first.x - pj.x, first.y - pj.y) < 1e-8) { closed = true; break; }
        }
      }
    }
    if (!closed) return false;
    if ((e.constantWidth || e.constWidth || 0) > 1e-9) return true;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if ((p.startWidth || 0) > 1e-9 || (p.endWidth || 0) > 1e-9 || (p.width || 0) > 1e-9) return true;
    }
    return false;
  };

  // 整图世界包围盒：惰性计算并缓存（所有空间所有实体的并集）
  DxfRenderer.prototype._getDocBounds = function () {
    if (this._docBounds) return this._docBounds;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    if (this.spaces) {
      for (var sp in this.spaces) {
        var ents = (this.spaces[sp] && this.spaces[sp].entities) || [];
        for (var i = 0; i < ents.length; i++) {
          var bb = ents[i]._bb;
          if (!bb && typeof bbox === 'function') bb = ents[i]._bb = bbox(ents[i], this);
          if (bb) { if (bb.x0 < minx) minx = bb.x0; if (bb.y0 < miny) miny = bb.y0; if (bb.x1 > maxx) maxx = bb.x1; if (bb.y1 > maxy) maxy = bb.y1; }
        }
      }
    }
    if (!isFinite(minx)) { this._docBounds = { x0: 0, y0: 0, x1: 0, y1: 0, area: 0 }; return this._docBounds; }
    this._docBounds = { x0: minx, y0: miny, x1: maxx, y1: maxy, area: (maxx - minx) * (maxy - miny) };
    return this._docBounds;
  };

  // 是否值得填充：用"该多段线世界包围盒短边 / 整图短边"做门槛——
  // 设备块等"小局部实体"会远小于 1% 而被填充；PUB_TITLE 这类图框/标题外框
  // （与整图同量级或达数个百分点）则保持空心描边，匹配商业 CAD 行为。
  // 注：constWidth 不会被块变换缩放，仍是局部值；因此以纯世界坐标比较最稳。
  DxfRenderer.prototype._isFillablePoly = function (e) {
    if (!this._isWideClosedPoly(e)) return false;
    var bb = e._bb || (e._bb = bbox(e, this));
    if (!bb) return false;
    var dw = bb.x1 - bb.x0, dh = bb.y1 - bb.y0;
    if (!(dw > 0) || !(dh > 0)) return false;
    var db = this._getDocBounds();
    if (!isFinite(db.x0)) return true;                    // 无整图范围信息时退化为不限制
    var docMin = Math.min(db.x1 - db.x0, db.y1 - db.y0);
    if (!(docMin > 0)) return true;
    return Math.min(dw, dh) / docMin < 0.01;              // < 1% 视为可填充的"实心箱体"
  };

  DxfRenderer.prototype._fillPoly = function (ctx, e, s, SX, SY) {
    var pts = e.vertices && e.vertices.length ? e.vertices : e.points;
    if (!pts || pts.length < 3) return;
    var P = new Path2D();
    this._pathPoly(P, e, s, SX, SY);
    // 对 f70=0 但几何闭合的多段线，_pathPoly 不会自动闭合，补充回到起点
    if (!(e.f70 & 1)) {
      var first = pts[0];
      P.lineTo(SX(first.x), SY(first.y));
    }
    ctx.fillStyle = this.colorOf(e);
    ctx.fill(P, 'evenodd');
  };

  // 凸度弧：bulge = tan(Δ/4)，精确求圆心半径后走 arc
  DxfRenderer.prototype._pathBulge = function (P, a, b, s, SX, SY) {
    var bl = a.bulge;
    var dx = b.x - a.x, dy = b.y - a.y;
    var chord = Math.hypot(dx, dy);
    if (chord < 1e-12) { P.lineTo(SX(b.x), SY(b.y)); return; }
    var theta = 4 * Math.atan(bl);              // 包含角（带符号）
    var r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    if (!isFinite(r) || r > chord * 1e6) { P.lineTo(SX(b.x), SY(b.y)); return; }
    // 圆心：中垂线上偏移
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    var h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    var sign = (Math.abs(theta) > Math.PI) ? -1 : 1;
    var ux = -dy / chord, uy = dx / chord;      // 左法向
    var dir = (bl > 0 ? 1 : -1) * sign;
    var cx = mx + ux * h * dir, cy = my + uy * h * dir;
    var a0 = Math.atan2(a.y - cy, a.x - cx), a1 = Math.atan2(b.y - cy, b.x - cx);
    var rp = r * s;
    if (rp < 0.2) { P.lineTo(SX(b.x), SY(b.y)); return; }
    // 屏幕角取负；bulge>0 世界逆时针 => 屏幕顺时针(anticlockwise=true)
    P.arc(SX(cx), SY(cy), rp, -a0, -a1, bl > 0);
  };

  DxfRenderer.prototype._pathEllipse = function (P, e, s, SX, SY) {
    if (!e.points[0]) return;
    var c = e.points[0];
    var mj = e.points[1] || { x: e.r40 || 1, y: 0 };
    var ra = Math.hypot(mj.x, mj.y);
    if (!(ra > 0)) return;
    var ratio = (e.ratio != null ? e.ratio : 1);
    var rb = ra * ratio;
    var rot = Math.atan2(mj.y, mj.x);
    var t0 = (e.startParam != null ? e.startParam : 0);
    var t1 = (e.endParam != null ? e.endParam : TAU);
    if (Math.abs(t1 - t0) < 1e-9) t1 = t0 + TAU;
    while (t1 <= t0) t1 += TAU;
    var rap = ra * s;
    if (rap < 0.3) return;
    // 屏幕系：Y 翻转 => 旋转取负、参数方向取反
    P.ellipse(SX(c.x), SY(c.y), rap, Math.abs(rb * s), -rot, -t0, -t1, true);
  };

  // SPLINE：优先按 NURBS(de Boor) 求值；退化时用拟合点/控制点折线
  DxfRenderer.prototype._pathSpline = function (P, e, s, SX, SY) {
    var pts = this.splinePoints(e, s);
    if (!pts || pts.length < 2) return;
    P.moveTo(SX(pts[0].x), SY(pts[0].y));
    for (var i = 1; i < pts.length; i++) P.lineTo(SX(pts[i].x), SY(pts[i].y));
    if ((e.f70 & 1) && pts.length > 2) P.lineTo(SX(pts[0].x), SY(pts[0].y));   // 闭合样条
  };

  DxfRenderer.prototype.splinePoints = function (e, s) {
    var ctrl = e.ctrl || [], knots = e.knots || [], deg = e.degree || 3;
    var n = ctrl.length;
    if (n < 2) return (e.fit && e.fit.length >= 2) ? e.fit.slice() : null;
    // 采样数按屏幕尺寸自适应
    var bb = e._bb;
    var pxLen = bb ? (Math.abs(bb.x1 - bb.x0) + Math.abs(bb.y1 - bb.y0)) * (s || 1) : 200;
    var N = Math.max(16, Math.min(400, Math.round(pxLen / 4)));
    if (knots.length !== n + deg + 1) {
      // 结点向量不合法：控制多边形（AutoCAD 至少形状接近）
      if (e.fit && e.fit.length >= 2) return e.fit.slice();
      return ctrl.slice();
    }
    var w = e.weights && e.weights.length === n ? e.weights : null;
    var out = [];
    var t0 = knots[deg], t1 = knots[n];
    if (!(t1 > t0)) return ctrl.slice();
    for (var i = 0; i <= N; i++) {
      var t = t0 + (t1 - t0) * i / N;
      if (i === N) t = t1 - 1e-12;
      out.push(deBoor(t, deg, ctrl, knots, w));
    }
    return out;
  };

  function deBoor(t, p, ctrl, knots, weights) {
    var n = ctrl.length;
    // 找结点区间
    var k = p;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    var dx = [], dy = [], dw = [];
    for (var j = 0; j <= p; j++) {
      var idx = k - p + j;
      if (idx < 0) idx = 0; if (idx > n - 1) idx = n - 1;
      var ww = weights ? weights[idx] : 1;
      dx.push(ctrl[idx].x * ww); dy.push(ctrl[idx].y * ww); dw.push(ww);
    }
    for (var r = 1; r <= p; r++) {
      for (var j2 = p; j2 >= r; j2--) {
        var i0 = k - p + j2;
        var den = knots[i0 + p - r + 1] - knots[i0];
        var alpha = den === 0 ? 0 : (t - knots[i0]) / den;
        dx[j2] = (1 - alpha) * dx[j2 - 1] + alpha * dx[j2];
        dy[j2] = (1 - alpha) * dy[j2 - 1] + alpha * dy[j2];
        dw[j2] = (1 - alpha) * dw[j2 - 1] + alpha * dw[j2];
      }
    }
    var W = dw[p] || 1;
    return { x: dx[p] / W, y: dy[p] / W };
  }

  // ---------------------------------------------------------------- 文字
  // SHX 是矢量笔画字体，浏览器无法直接用；AutoCAD 找不到 SHX 时也会按 FONTALT 替换。
  // 这里按「中文形笔画 / 西文单线 / 等宽」三类做替换，保证字形观感与 AutoCAD 接近且中文不丢字。
  var FONT_CN_SONG = '"SimSun", "宋体", "NSimSun", "Microsoft YaHei", sans-serif';
  var FONT_CN_HEI = '"SimHei", "黑体", "Microsoft YaHei", sans-serif';
  var FONT_CN_FANG = '"FangSong", "仿宋", "STFangsong", "SimSun", sans-serif';
  var FONT_CN_KAI = '"KaiTi", "楷体", "STKaiti", "SimSun", sans-serif';
  var FONT_LAT_SINGLE = '"Tahoma", "Segoe UI", Arial, sans-serif';   // 单线西文（romans/simplex/txt）
  var FONT_LAT_SERIF = '"Times New Roman", Georgia, serif';          // romanc/romand 衬线
  var FONT_LAT_ITAL = 'italic "Tahoma", "Segoe UI", Arial, sans-serif';

  // key 一律小写、去路径、去扩展名
  var SHX_SUBST = {
    // ---- 中文大字体 / 中文形（宋体系）----
    gbcbig: FONT_CN_SONG, hztxt: FONT_CN_SONG, hzt: FONT_CN_SONG, hzs: FONT_CN_SONG,
    '@hztxt': FONT_CN_SONG, '0hztxt': FONT_CN_SONG, '1-hztxt': FONT_CN_SONG,
    'aad-hztxt': FONT_CN_SONG, fhztxt: FONT_CN_SONG, hztxt33: FONT_CN_SONG,
    hztxt_e: FONT_CN_SONG, chineset: FONT_CN_SONG, china: FONT_CN_SONG,
    tssdchn: FONT_CN_SONG, yjkchn: FONT_CN_SONG, pkpmchn: FONT_CN_SONG,
    bzhz: FONT_CN_SONG, bzxw: FONT_CN_SONG, bzxw_tssd: FONT_CN_SONG,
    stedi: FONT_CN_SONG, '@stedi': FONT_CN_SONG, sltxt: FONT_CN_SONG,
    wzs: FONT_CN_SONG, jd: FONT_CN_SONG, rt: FONT_CN_SONG, rs: FONT_CN_SONG,
    ht: FONT_CN_HEI, hzdx: FONT_CN_HEI, stxihei: FONT_CN_HEI, simhei: FONT_CN_HEI,
    hzfs: FONT_CN_FANG, gbhzfs: FONT_CN_FANG, syfs: FONT_CN_FANG,
    stfangso: FONT_CN_FANG, fsgb2312: FONT_CN_FANG, simfang: FONT_CN_FANG,
    fs64f: FONT_CN_FANG, sysz: FONT_CN_SONG,
    ktgb2312: FONT_CN_KAI,
    // ---- 西文单线（AutoCAD 标准 SHX）----
    txt: FONT_LAT_SINGLE, txt33: FONT_LAT_SINGLE, txt4: FONT_LAT_SINGLE, 'aad-txt': FONT_LAT_SINGLE,
    simplex: FONT_LAT_SINGLE, complex: FONT_LAT_SERIF, monotxt: FONT_LAT_SINGLE,
    gbenor: FONT_LAT_SINGLE, gbeitc: FONT_LAT_ITAL, italic: FONT_LAT_ITAL,
    romans: FONT_LAT_SINGLE, romanc: FONT_LAT_SERIF, romand: FONT_LAT_SERIF,
    'new-romd': FONT_LAT_SERIF, ros: FONT_LAT_SINGLE, ros1: FONT_LAT_SINGLE,
    tssdeng: FONT_LAT_SINGLE, tssdeng2: FONT_LAT_SINGLE, yjkeng: FONT_LAT_SINGLE,
    pkpmeng: FONT_LAT_SINGLE, bweng: FONT_LAT_SINGLE, superos: FONT_LAT_SINGLE,
    dim: FONT_LAT_SINGLE, din: FONT_LAT_SINGLE, aaa: FONT_LAT_SINGLE,
    archstyl: FONT_LAT_SINGLE, exthalf2: FONT_LAT_SINGLE, scriptc: FONT_LAT_ITAL,
    isocp: FONT_LAT_SINGLE, amgdt: FONT_LAT_SINGLE, bigfont: FONT_CN_SONG,
    // ---- TrueType 常见中文名（有些 style 直接写中文字体）----
    simsun: FONT_CN_SONG, nsimsun: FONT_CN_SONG, 宋体: FONT_CN_SONG, 黑体: FONT_CN_HEI,
    仿宋: FONT_CN_FANG, 楷体: FONT_CN_KAI, 微软雅黑: '"Microsoft YaHei", sans-serif',
    // ---- 常规 TrueType 西文/日文（直通即可，仍挂中文兜底防丢字）----
    arial: '"Arial", ' + FONT_CN_SONG, tahoma: '"Tahoma", ' + FONT_CN_SONG,
    verdana: '"Verdana", ' + FONT_CN_SONG, calibri: '"Calibri", ' + FONT_CN_SONG,
    'times new roman': '"Times New Roman", ' + FONT_CN_SONG,
    'courier new': '"Courier New", monospace, ' + FONT_CN_SONG,
    'yu gothic': '"Yu Gothic", "Meiryo", ' + FONT_CN_SONG,
    'ms gothic': '"MS Gothic", ' + FONT_CN_SONG, meiryo: '"Meiryo", ' + FONT_CN_SONG
  };

  function normFontKey(name) {
    var s = String(name || '').trim();
    s = s.replace(/^.*[\\/]/, '');                  // 去掉 C:\SHX\ 之类路径
    s = s.replace(/\.(shx|ttf|ttc|otf|pfb)$/i, ''); // 去扩展名
    return s.toLowerCase();
  }
  // 是否为中文取向的字体（决定中文能否显示）
  function isCnFont(key) {
    var v = SHX_SUBST[key];
    return v === FONT_CN_SONG || v === FONT_CN_HEI || v === FONT_CN_FANG || v === FONT_CN_KAI;
  }

  DxfRenderer.prototype._fontFamilyFor = function (style) {
    if (!style) return FONT_CN_SONG;
    if (style._fam) return style._fam;                          // 缓存
    var raw = String(style.font || '');
    var key = normFontKey(raw);
    var bigKey = normFontKey(style.bigFont || '');
    var fam = null;

    // 1) 有大字体（BIGFONT）→ 中文一定要能显示，优先用大字体的取向
    if (bigKey && SHX_SUBST[bigKey]) fam = SHX_SUBST[bigKey];
    // 2) 主字体查表
    if (!fam && key && SHX_SUBST[key]) fam = SHX_SUBST[key];
    // 3) TrueType 未在表内：直接用其字体名，后接中文兜底
    if (!fam && raw && !/\.shx$/i.test(raw)) {
      var pure = raw.replace(/^.*[\\/]/, '').replace(/\.(tt[fc]|otf)$/i, '');
      if (pure) fam = '"' + pure + '", ' + FONT_CN_SONG;
    }
    // 4) 模糊匹配（含 hz/中文关键字视作中文）
    if (!fam) {
      if (/hz|chn|chin|song|hei|fs|kai|kt|st\d|sd|cn|大字/.test(key)) fam = FONT_CN_SONG;
      else if (/rom|iso|arial|txt|eng|simp|dim/.test(key)) fam = FONT_LAT_SINGLE;
    }
    // 5) 兜底：宋体（能显示中文也能显示西文，与 AutoCAD 缺字体时替换成 simplex 相比更保守但不丢字）
    if (!fam) fam = FONT_CN_SONG;

    // 若主字体是西文取向但有大字体，则合并中文兜底，避免中文丢字
    if (bigKey && !isCnFont(key)) fam = fam.replace(/sans-serif$|serif$/, '') + FONT_CN_SONG;

    style._fam = fam;
    return fam;
  };

  // MTEXT 控制码 → 纯文本。
  // 注意顺序陷阱：\P（段落换行）必须在 \p（段落属性 \pxi-3,l4,t4;）之前处理，
  // 且 \p 规则不能带 i 标志——否则 "\P...;" 会被整段当成属性码吞掉，造成掉字掉行。
  function stripMtext(s) {
    if (s == null) return '';
    s = String(s);
    s = s.replace(/\\\\/g, '\u0001');                 // 先保护转义反斜杠，避免误伤
    // 堆叠分数 \S1^2; / \S1/2; -> 1/2
    s = s.replace(/\\S([^;]*);/g, function (m0, g1) { return g1.replace(/[\^#]/g, '/'); });
    s = s.replace(/\\P/g, '\n');                      // 段落换行：最先处理
    s = s.replace(/\\p[^;]*;/g, '');                  // 段落属性：仅小写
    s = s.replace(/\\[Ff][^;]*;/g, '')                // 字体
      .replace(/\\[Cc]\d+;?/g, '')                    // 颜色
      .replace(/\\A\d+;?/g, '')                       // 垂直对齐
      .replace(/\\H[^;]*;/g, '')                      // 字高
      .replace(/\\W[^;]*;/g, '')                      // 宽度因子
      .replace(/\\Q[^;]*;/g, '')                      // 倾斜角
      .replace(/\\T[^;]*;/g, '')                      // 字距
      .replace(/\\[LlOoKk]/g, '')                     // 下划线/上划线/删除线开关
      .replace(/\\~/g, '\u00A0')                      // 不断行空格
      .replace(/\\([{}])/g, '$1')                     // 转义花括号
      .replace(/[{}]/g, '');                          // 分组符
    s = s.replace(/\u0001/g, '\\');
    s = s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
      .replace(/%%[uU]/g, '').replace(/%%[oO]/g, '').replace(/%%%/g, '%');
    return s;
  }

  // 按 MTEXT 定义宽度做折行（AutoCAD 会在参照矩形宽度处自动换行）。
  // limit 单位与 ctx.measureText 一致（px，未含 wf 缩放）。中文可逐字断行，
  // 西文优先在空白处断行，与 AutoCAD 的排版行为一致。
  function wrapLine(ctx, text, limit) {
    if (!(limit > 0) || !text) return [text];
    if (ctx.measureText(text).width <= limit) return [text];
    var out = [], cur = '', lastSpace = -1;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var trial = cur + ch;
      if (/\s/.test(ch)) lastSpace = cur.length;
      if (ctx.measureText(trial).width > limit && cur.length) {
        // 西文单词内不硬断：回退到最近空白处
        var cjk = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
        if (!cjk && lastSpace > 0) {
          out.push(cur.slice(0, lastSpace));
          cur = cur.slice(lastSpace).replace(/^\s+/, '') + ch;
        } else {
          out.push(cur); cur = ch;
        }
        lastSpace = -1;
      } else cur = trial;
    }
    if (cur) out.push(cur);
    return out;
  }

  // 解析文字高度：DXF 里 group 40 为 0 时表示「使用文字样式固定高度」；
  // 样式高度也为 0 时回退到 $TEXTSIZE；都没有才用 2.5 兜底。
  DxfRenderer.prototype._resolveTextHeight = function (e) {
    var h = e.r40;
    if (h > 0) return h;
    var doc = this.doc;
    var sn = e.style || 'Standard';
    var style = (doc && doc.styles[sn]) || (doc && (doc.styles['Standard'] || doc.styles['STANDARD']));
    h = style && style.height;
    if (h > 0) return h;
    h = doc && doc.textsize;
    if (h > 0) return h;
    return 2.5;
  };

  // 文字总入口：默认把 SHX 字体映射为系统字体渲染（useSystemFontForShx=true，零 shx 依赖）；
  // 仅当开关关闭时才解析矢量字形并走旧 ShxText 描边兜底路径。
  DxfRenderer.prototype._drawText = function (ctx, e, s, SX, SY) {
    if (!this.useSystemFontForShx && typeof ShxText !== 'undefined') {
      var doc = this.doc;
      var sn = e.style || 'Standard';
      var style = (doc && doc.styles[sn]) || (doc && (doc.styles['Standard'] || doc.styles['STANDARD']));
      var pk = style ? style.font : null, bk = style ? style.bigFont : null;
      var st = ShxText.resolveStyle(pk, bk);
      if (st && st.ok) { this._drawTextShx(ctx, e, s, SX, SY, st); return; }
    }
    this._drawTextSys(ctx, e, s, SX, SY);
  };

  // 系统字体渲染：纯浏览器字体引擎填充；SHX 字体经 _fontFamilyFor 映射为系统字体族后也走此路径。
  DxfRenderer.prototype._drawTextSys = function (ctx, e, s, SX, SY) {
    // 对齐点：TEXT 的 72/73 非 0 时用第二点(11,21)
    var base = e.points[0];
    if ((e.hAlign || e.vAlign) && e.points[1] && (e.points[1].x || e.points[1].y)) base = e.points[1];
    if (!base) return;
    var hRaw = Math.abs(this._resolveTextHeight(e)) * s;
    if (hRaw < 0.5) return;               // 原始高度几乎为 0，跳过
    // SHX 映射为系统字体后，字号与正常 TrueType 系统字体保持一致（统一用 textScaleSys=1.0），
    // 不再沿用旧 SHX 描边的 4 倍放大系数，避免映射字体比正常字体大/小一圈。
    var scale = this.textScaleSys;
    var minPx = this.minTextPxSys;
    var maxPx = this.maxTextPxSys;
    var h = Math.min(maxPx, Math.max(minPx, hRaw * scale));
    var doc = this.doc;
    var style = (e.style && doc && doc.styles[e.style]) || (doc && (doc.styles['Standard'] || doc.styles['STANDARD']));
    var family = this._fontFamilyFor(style);
    var wf = e.widthFactor || (style && style.xscale) || 1;
    var rot = (e.a50 || 0) * D2R;
    var raw = stripMtext(e.text);
    if (!raw) return;

    ctx.fillStyle = '#ffffff';        // 字体统一纯白色，确保深色背景下始终可读
    ctx.font = h + 'px ' + family;

    var isM = (e.type === 'MTEXT');
    var align = 'left', baseline = 'alphabetic', rown = 0;
    var ha = 0, va = 0;
    if (isM) {
      var at = e.attach || 1;               // 1..9: 左上..右下
      var coln = (at - 1) % 3;              // 0 左 1 中 2 右
      rown = Math.floor((at - 1) / 3);      // 0 上 1 中 2 下
      align = coln === 0 ? 'left' : (coln === 1 ? 'center' : 'right');
      baseline = rown === 0 ? 'top' : (rown === 1 ? 'middle' : 'bottom');
    } else {
      ha = e.hAlign || 0; va = e.vAlign || 0;
      align = (ha === 1 || ha === 4) ? 'center' : (ha === 2 ? 'right' : 'left');
      baseline = (va === 1) ? 'bottom' : (va === 2 ? 'middle' : (va === 3) ? 'top' : 'alphabetic');
      if (ha === 3 || ha === 5) align = 'left';   // 对齐/布满：从起点向终点排布
    }

    // MTEXT 按参照宽度(41)折行；折行阈值要除掉宽度因子，因为 wf 是画布缩放
    var lines = raw.split('\n');
    if (isM && e.refWidth > 0) {
      var limit = (e.refWidth * s) / (wf || 1);
      var wrapped = [];
      for (var wi = 0; wi < lines.length; wi++) {
        var parts = wrapLine(ctx, lines[wi], limit);
        for (var pi = 0; pi < parts.length; pi++) wrapped.push(parts[pi]);
      }
      lines = wrapped;
    }

    // 行距：AutoCAD 的 MTEXT 单倍行距 = 5/3 字高，再乘行距因子(44)
    var lh = isM ? h * (5 / 3) * (e.lineSpacing || 1) : h * (5 / 3);

    // TEXT 的「对齐(3)/布满(5)」：把文字压缩到两个对齐点之间
    var fitScale = 1;
    if (!isM && (ha === 3 || ha === 5) && e.points[0] && e.points[1]) {
      var dx = e.points[1].x - e.points[0].x, dy = e.points[1].y - e.points[0].y;
      var span = Math.hypot(dx, dy) * s;
      var wNat = ctx.measureText(lines[0] || '').width * (wf || 1);
      if (span > 0.5 && wNat > 0.5) fitScale = span / wNat;
      base = e.points[0];
      rot = Math.atan2(dy, dx);            // 方向由两点决定
    }

    ctx.textAlign = align; ctx.textBaseline = baseline;
    ctx.save();
    ctx.translate(SX(base.x), SY(base.y));
    if (rot) ctx.rotate(-rot);
    if (wf * fitScale !== 1) ctx.scale(wf * fitScale, 1);

    // 多行整体锚定：'middle'/'bottom' 应对齐整块文字，而不是逐行各自居中/底对齐
    var n = lines.length;
    var y0 = 0;
    if (isM && n > 1) {
      if (rown === 1) y0 = -((n - 1) * lh) / 2;      // 垂直居中
      else if (rown === 2) y0 = -(n - 1) * lh;       // 底对齐
    }
    for (var i = 0; i < n; i++) {
      var ln = lines[i]; if (!ln) continue;
      ctx.fillText(ln, 0, y0 + i * lh);
    }
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  // 真实 SHX 矢量字形绘制：描边 @mlightcad/shx-parser 解出的字形折线
  DxfRenderer.prototype._drawTextShx = function (ctx, e, s, SX, SY, st) {
    var base = e.points[0];
    if ((e.hAlign || e.vAlign) && e.points[1] && (e.points[1].x || e.points[1].y)) base = e.points[1];
    if (!base) return;
    var modelH = Math.abs(this._resolveTextHeight(e));
    if (modelH < 0.05) return;
    // naturalH 为屏幕像素高度：modelH * 视图缩放 s * SHX 放大系数。
    // 用于判断是否低于 minTextPxShx（回退系统字体）或超过 maxTextPxShx（上限防爆屏）。
    var naturalH = modelH * s * this.textScaleShx;
    if (naturalH < this.minTextPxShx) { this._drawTextSys(ctx, e, s, SX, SY); return; }
    // layoutLine 期望 H 为模型单位（DXF 字高），输出的是局部世界坐标，再由 SX/SY 负责视图缩放。
    // 旧版把屏幕像素 naturalH 直接传进去，导致 SX/SY 再乘一次 s，字高变成 s² 缩放。
    // v1.0.22：取消 256px 上限，放大时 SHX 字高与几何同步线性增长，不再被截断缩小一半。
    var Hscreen = (this.maxTextPxShx > 0 && naturalH > this.maxTextPxShx) ? this.maxTextPxShx : naturalH;
    var H = Hscreen / s;
    var wf = e.widthFactor || 1;
    var rot = (e.a50 || 0) * D2R;
    var raw = stripMtext(e.text);
    if (!raw) return;

    var isM = (e.type === 'MTEXT');
    var ha = isM ? 0 : (e.hAlign || 0);
    var va = isM ? 0 : (e.vAlign || 0);
    var at = e.attach || 1;

    // 行划分 + MTEXT 按参照宽度折行（用 SHX 实测宽度，避免系统字体近似误差）
    var lines = raw.split('\n');
    if (isM && e.refWidth > 0) {
      var limit = e.refWidth / (wf || 1);   // 模型单位，与 layout 宽度同单位
      var wrapped = [];
      for (var wi = 0; wi < lines.length; wi++) {
        var wp = this._wrapLineShx(lines[wi], limit, st, H);
        for (var wj = 0; wj < wp.length; wj++) wrapped.push(wp[wj]);
      }
      lines = wrapped;
    }

    var lineH = H * (5 / 3) * (e.lineSpacing || 1);
    var layouts = [], totalW = 0, maxTop = -Infinity, minBot = Infinity;
    for (var i = 0; i < lines.length; i++) {
      var lay = ShxText.layoutLine(lines[i], st, H);
      if (!lay.ok) { this._drawTextSys(ctx, e, s, SX, SY); return; }   // 该行渲染不了 → 整段回退
      layouts.push(lay);
      if (lay.width > totalW) totalW = lay.width;
      var top = -i * lineH + lay.maxY, bot = -i * lineH + lay.minY;
      if (top > maxTop) maxTop = top;
      if (bot < minBot) minBot = bot;
    }
    if (!isFinite(minBot)) return;

    // 对齐锚点（局部世界坐标，y 向上）
    var anchorX = 0, anchorY = 0;
    if (isM) {
      var coln = (at - 1) % 3, rown = Math.floor((at - 1) / 3);
      anchorX = coln === 0 ? 0 : coln === 1 ? totalW / 2 : totalW;
      anchorY = rown === 0 ? maxTop : rown === 1 ? (minBot + maxTop) / 2 : minBot;
    } else {
      if (ha === 1 || ha === 4) anchorX = totalW / 2;
      else if (ha === 2) anchorX = totalW;
      else anchorX = 0;
      if (va === 1) anchorY = minBot;
      else if (va === 2) anchorY = (minBot + maxTop) / 2;
      else if (va === 3) anchorY = maxTop;
      else anchorY = 0;
    }

    // TEXT 对齐(3)/布满(5)：两点间拉伸
    var fitScale = 1, useRot = rot, fitBase = base;
    if (!isM && (ha === 3 || ha === 5) && e.points[0] && e.points[1]) {
      var ddx = e.points[1].x - e.points[0].x, ddy = e.points[1].y - e.points[0].y;
      var span = Math.hypot(ddx, ddy);   // 模型距离，与 totalW（模型单位）同单位
      if (span > 0.5 && totalW > 0.5) fitScale = span / totalW;
      fitBase = e.points[0];
      useRot = Math.atan2(ddy, ddx);
    }

    // 描边所有字形折线（单笔 SHX = 描边非填充，与 AutoCAD 线框文字一致）
    ctx.save();
    ctx.strokeStyle = '#ffffff';      // SHX 字体统一纯白色
    // SHX 单线字体：线宽恒定 1px（shxLineWidth），不随视图缩放/字高变化；
    // 放大缩小时字高（经过 SX/SY 缩放）随页面同步、而笔画始终是 1px 细线。
    ctx.lineWidth = this.shxLineWidth;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (var li = 0; li < layouts.length; li++) {
      var lay2 = layouts[li];
      var yoff = -li * lineH;
      for (var p = 0; p < lay2.polylines.length; p++) {
        var pl = lay2.polylines[p];
        for (var q = 0; q < pl.length; q++) {
          var lx = (pl[q].x - anchorX) * (wf * fitScale);
          var ly = (pl[q].y - anchorY) + yoff;
          var wx = fitBase.x + (lx * Math.cos(useRot) - ly * Math.sin(useRot));
          var wy = fitBase.y + (lx * Math.sin(useRot) + ly * Math.cos(useRot));
          var sx = SX(wx), sy = SY(wy);
          if (q === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  // 按 SHX 实测宽度折行（MTEXT 参照矩形宽度处自动换行）
  DxfRenderer.prototype._wrapLineShx = function (text, limit, st, H) {
    if (!(limit > 0) || !text) return [text];
    var glyphs = Array.from(text);
    var cur = '', out = [];
    for (var i = 0; i < glyphs.length; i++) {
      var trial = cur + glyphs[i];
      var lay = ShxText.layoutLine(trial, st, H);
      if (lay.ok && lay.width > limit && cur.length) {
        var lastSpace = cur.lastIndexOf(' ');
        var cjk = /[⺀-鿿豈-﫿＀-￯]/.test(glyphs[i]);
        if (!cjk && lastSpace > 0) {
          out.push(cur.slice(0, lastSpace));
          cur = cur.slice(lastSpace + 1) + glyphs[i];
        } else { out.push(cur); cur = glyphs[i]; }
      } else cur = trial;
    }
    if (cur) out.push(cur);
    return out;
  };

  // ---------------------------------------------------------------- 填充类
  DxfRenderer.prototype._drawSolid = function (ctx, e, SX, SY) {
    var p = e.points; if (!p || p.length < 3) return;
    // DXF SOLID/3DFACE 顶点序为 0,1,3,2（第 4 点可能等于第 3 点）
    var order = (p.length >= 4 && p[3]) ? [0, 1, 3, 2] : [0, 1, 2];
    ctx.fillStyle = this.colorOf(e);
    ctx.beginPath();
    for (var i = 0; i < order.length; i++) {
      var q = p[order[i]]; if (!q) continue;
      if (i === 0) ctx.moveTo(SX(q.x), SY(q.y)); else ctx.lineTo(SX(q.x), SY(q.y));
    }
    ctx.closePath();
    if (e.type === '3DFACE') { ctx.strokeStyle = this.colorOf(e); ctx.stroke(); }
    else ctx.fill();
  };

  // HATCH：把边界环（含 line/arc/ellipse/spline 边 与 polyline 环）求值成路径
  DxfRenderer.prototype._loopPath = function (P, lp, s, SX, SY) {
    // 同 _pathEntity：填充边界描边也按 dpr 吸附到设备像素中心，消除 1px 边界线随 zoom 闪烁。
    var _sx = SX, _sy = SY;
    var dpr = this.dpr || 1;
    SX = function (x) { return Math.round(_sx(x) * dpr) / dpr + 0.5 / dpr; };
    SY = function (y) { return Math.round(_sy(y) * dpr) / dpr + 0.5 / dpr; };
    if (lp.polyline && lp.vertices && lp.vertices.length) {
      var v = lp.vertices;
      P.moveTo(SX(v[0].x), SY(v[0].y));
      for (var i = 1; i < v.length; i++) {
        if (v[i - 1].bulge) this._pathBulge(P, v[i - 1], v[i], s, SX, SY);
        else P.lineTo(SX(v[i].x), SY(v[i].y));
      }
      if (v.length > 2) {
        if (v[v.length - 1].bulge) this._pathBulge(P, v[v.length - 1], v[0], s, SX, SY);
      }
      P.closePath();
      return true;
    }
    if (lp.edges && lp.edges.length) {
      var started = false;
      for (var k = 0; k < lp.edges.length; k++) {
        var ed = lp.edges[k]; if (!ed) continue;
        if (ed.kind === 'line') {
          if (ed.x1 == null || ed.x2 == null) continue;
          if (!started) { P.moveTo(SX(ed.x1), SY(ed.y1)); started = true; }
          else P.lineTo(SX(ed.x1), SY(ed.y1));
          P.lineTo(SX(ed.x2), SY(ed.y2));
        } else if (ed.kind === 'arc') {
          if (ed.cx == null) continue;
          var r = Math.abs((ed.r || 0) * s); if (r < 0.15) continue;
          var a0 = ed.a1 || 0, a1 = (ed.a2 != null ? ed.a2 : 360);
          var ccw = (ed.ccw == null) ? 1 : ed.ccw;
          if (ccw) { while (a1 <= a0) a1 += 360; } else { while (a1 >= a0) a1 -= 360; }
          var cx = SX(ed.cx), cy = SY(ed.cy);
          var sxp = cx + r * Math.cos(-a0 * D2R), syp = cy + r * Math.sin(-a0 * D2R);
          if (!started) { P.moveTo(sxp, syp); started = true; } else P.lineTo(sxp, syp);
          P.arc(cx, cy, r, -a0 * D2R, -a1 * D2R, !!ccw);
        } else if (ed.kind === 'ellipse') {
          if (ed.cx == null) continue;
          var ra = Math.hypot(ed.mx || 0, ed.my || 0), rt = ed.ratio != null ? ed.ratio : 1;
          if (!(ra > 0)) continue;
          var rotE = Math.atan2(ed.my || 0, ed.mx || 0);
          var e0 = (ed.a1 || 0) * D2R, e1 = (ed.a2 != null ? ed.a2 : 360) * D2R;
          while (e1 <= e0) e1 += TAU;
          if (!started) { started = true; }
          P.ellipse(SX(ed.cx), SY(ed.cy), ra * s, ra * rt * s, -rotE, -e0, -e1, true);
        } else if (ed.kind === 'spline' && ed.ctrl && ed.ctrl.length >= 2) {
          var sp = this.splinePoints({ ctrl: ed.ctrl, knots: ed.knots, degree: ed.degree || 3, _bb: null }, s) || ed.ctrl;
          if (!started) { P.moveTo(SX(sp[0].x), SY(sp[0].y)); started = true; }
          else P.lineTo(SX(sp[0].x), SY(sp[0].y));
          for (var q2 = 1; q2 < sp.length; q2++) P.lineTo(SX(sp[q2].x), SY(sp[q2].y));
        }
      }
      if (started) { P.closePath(); return true; }
    }
    return false;
  };

  DxfRenderer.prototype._drawHatch = function (ctx, e, s, SX, SY) {
    if (!e.boundaryLoops || !e.boundaryLoops.length) return;
    var P = new Path2D();
    var any = false;
    for (var i = 0; i < e.boundaryLoops.length; i++) {
      if (this._loopPath(P, e.boundaryLoops[i], s, SX, SY)) any = true;
    }
    if (!any) return;
    var col = this.colorOf(e);
    var isSolid = e.solid || (e.pattern && /^solid$/i.test(e.pattern));
    ctx.save();
    if (isSolid) {
      ctx.fillStyle = col;
      ctx.fill(P, 'evenodd');          // 偶奇规则 => 内环自动挖空，和 AutoCAD 普通(Normal)样式一致
    } else {
      // 图案填充：裁剪出边界后按图案定义线铺线，比逐环求交稳定
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.save();
      ctx.clip(P, 'evenodd');
      var bb = e._bb || this.bboxOf(e);   // 兜底：极少数为 null 时也保证能按边界铺填充，绝不整块不显示
      if (bb) {
        if (e.patLines && e.patLines.length) this._hatchByPattern(ctx, e, bb, s, SX, SY);
        else this._hatchFallback(ctx, e, bb, SX, SY);
      }
      ctx.restore();
    }
    ctx.restore();
  };

  // 按 DXF 里的真实图案定义线绘制（图形单位 → 缩放时密度随之变化，与 AutoCAD 一致）。
  // 两个易错点：
  //  1) AutoCAD 写出的图案定义线数据【已经包含】比例(41)与旋转(52)，不可再叠加一次。
  //  2) 组码 45/46 是【世界坐标偏移向量】，不是「沿线位移 + 垂直间距」两个分量。
  //     实测 ANSI31（PAT 定义 45,0,0,0,.125，沿线位移为 0）写出的是 (-11.225, 11.225)，
  //     与 45° 线方向点积为 0，即纯垂直偏移；若把 oy 当垂直间距会偏密 √2 倍。
  DxfRenderer.prototype._hatchByPattern = function (ctx, e, bb, s, SX, SY) {
    var lines = e.patLines;
    var cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    var halfDiag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 + 1e-9;
    var LINE_CAP = 3000;          // 单个填充最多铺的线数，防极端图案卡死
    var drawn = 0;

    for (var li = 0; li < lines.length; li++) {
      var pl = lines[li];
      var a = (pl.angle || 0) * D2R;
      var dx = Math.cos(a), dy = Math.sin(a);       // 线方向（图形坐标）
      var nx = -dy, ny = dx;                        // 法向
      var ox = pl.ox || 0, oy = pl.oy || 0;         // 世界坐标偏移向量
      var step = ox * nx + oy * ny;                 // 偏移向量在法向上的投影 = 真实垂直间距
      var perp = Math.abs(step);
      // 偏移与线方向平行（无垂直间距）→ 只画一条，避免死循环
      if (!(perp > 1e-12)) { perp = halfDiag * 2 || 1; step = perp; }

      // 自适应线宽：线距越小线越细（但保留可见下限），使斜线在任何缩放都呈“线条”观感，
      // 不会塌缩成实心块——与 AutoCAD 一致（密集时仍画细线而非填实）。
      ctx.lineWidth = Math.max(0.2, Math.min(1, perp * s * 0.5));
      var need = Math.ceil((halfDiag * 2) / perp) + 2;
      if (need > LINE_CAP - drawn) need = Math.max(0, LINE_CAP - drawn);
      if (!need) break;

      // 让 k=0 那条线落在包围盒中心附近：把中心投影到法向，换算成 k
      var bx = pl.bx || 0, by = pl.by || 0;
      // 包围盒中心相对图案基准点的法向距离；用于把每条线锚定在边界本身而非世界原点，
      // 否则当 HATCH 远离原点（如坐标在 1.9e6 处）时，所有线会聚到原点附近被裁剪掉而“不显示”。
      var CNb = (cx - bx) * nx + (cy - by) * ny;
      var k0 = Math.round(((cx - bx) * nx + (cy - by) * ny) / step);
      var kFrom = k0 - Math.ceil(need / 2), kTo = k0 + Math.ceil(need / 2);

      // 虚线段：正=画，负=空，0=点
      var dash = null;
      if (pl.dashes && pl.dashes.length) {
        dash = [];
        for (var di = 0; di < pl.dashes.length; di++) {
          var dv = Math.abs(pl.dashes[di]) * s;
          dash.push(dv < 0.1 ? 0.1 : dv);           // 0 长度当点画，给个极小值
        }
        if (pl.dashes[0] < 0) dash.unshift(0.1);    // 以空白开头
        if (dash.length % 2) dash = dash.concat(dash);
      }
      ctx.setLineDash(dash || []);

      ctx.beginPath();
      for (var k = kFrom; k <= kTo; k++) {
        // 第 k 条线在法向上的距离 = k*step；把这条线“锚点”放到包围盒中心附近，
        // 使线段落在边界内（而非世界原点附近）。Q_k = C + (k*step - CNb)*n
        var qx = cx + (k * step - CNb) * nx;
        var qy = cy + (k * step - CNb) * ny;
        ctx.moveTo(SX(qx - dx * halfDiag), SY(qy - dy * halfDiag));
        ctx.lineTo(SX(qx + dx * halfDiag), SY(qy + dy * halfDiag));
        drawn++;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (drawn >= LINE_CAP) break;
    }
  };

  // 没有图案定义线时（少见/异常文件）的近似：45° 等距斜线
  DxfRenderer.prototype._hatchFallback = function (ctx, e, bb, SX, SY) {
    var x0 = SX(bb.x0), x1 = SX(bb.x1), y0 = SY(bb.y1), y1 = SY(bb.y0);
    var ang = -((e.patternAngle != null ? e.patternAngle : 45)) * D2R;
    var sp = Math.max(3, (e.patternScale || 1) * 3.2);
    var diag = Math.hypot(x1 - x0, y1 - y0) + sp * 2;
    var mx2 = (x0 + x1) / 2, my2 = (y0 + y1) / 2;
    var dxu = Math.cos(ang), dyu = Math.sin(ang);
    var nxu = -dyu, nyu = dxu;
    ctx.beginPath();
    for (var t = -diag; t <= diag; t += sp) {
      var px = mx2 + nxu * t, py = my2 + nyu * t;
      ctx.moveTo(px - dxu * diag, py - dyu * diag);
      ctx.lineTo(px + dxu * diag, py + dyu * diag);
    }
    ctx.stroke();
  };

  // ---------------------------------------------------------------- 选中/覆盖层
  DxfRenderer.prototype._strokeSelect = function (ctx, e, s, SX, SY) {
    ctx.save();
    ctx.strokeStyle = '#00d1ff'; ctx.fillStyle = '#00d1ff'; ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    var P = new Path2D();
    this._pathEntity(P, e, s, SX, SY);
    if (e.boundaryLoops) for (var i = 0; i < e.boundaryLoops.length; i++) this._loopPath(P, e.boundaryLoops[i], s, SX, SY);
    ctx.stroke(P);
    ctx.setLineDash([]);
    // 夹点
    var gp = [];
    if (e.points) for (var k = 0; k < e.points.length; k++) if (e.points[k]) gp.push(e.points[k]);
    if (e.vertices) for (var v = 0; v < e.vertices.length && v < 200; v++) gp.push(e.vertices[v]);
    for (var q = 0; q < gp.length; q++) {
      var sx2 = SX(gp[q].x), sy2 = SY(gp[q].y);
      ctx.fillRect(sx2 - 3, sy2 - 3, 6, 6);
    }
    ctx.restore();
  };

  DxfRenderer.prototype._drawOverlays = function (ctx, s, SX, SY) {
    for (var i = 0; i < this.overlays.length; i++) {
      var o = this.overlays[i];
      ctx.strokeStyle = o.color || '#00e5ff'; ctx.fillStyle = o.color || '#00e5ff'; ctx.lineWidth = 1.5;
      if (o.kind === 'seg' || o.kind === 'poly') {
        var pts = o.kind === 'seg' ? [o.a, o.b] : o.pts;
        ctx.beginPath();
        for (var j = 0; j < pts.length; j++) {
          var q = pts[j];
          if (j === 0) ctx.moveTo(SX(q.x), SY(q.y)); else ctx.lineTo(SX(q.x), SY(q.y));
        }
        if (o.close) ctx.closePath();
        ctx.stroke();
        if (o.fill) { ctx.save(); ctx.globalAlpha = 0.18; ctx.fill(); ctx.restore(); }
      } else if (o.kind === 'dot') {
        ctx.beginPath(); ctx.arc(SX(o.p.x), SY(o.p.y), 3.5, 0, TAU); ctx.fill();
      } else if (o.kind === 'text') {
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.fillText(o.text, SX(o.p.x) + 5, SY(o.p.y) - 5);
      } else if (o.kind === 'arc') {
        ctx.beginPath(); ctx.arc(SX(o.c.x), SY(o.c.y), Math.abs(o.r * s), -o.a1, -o.a0, false); ctx.stroke();
      }
      if (o.label) {
        var anchor = o.a || (o.pts && o.pts[0]) || o.p || (o.c || { x: 0, y: 0 });
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
        var lx = SX(anchor.x) + 7, ly = SY(anchor.y) - 7;
        var tw = ctx.measureText(o.label).width;
        ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(lx - 3, ly - 13, tw + 6, 17); ctx.restore();
        ctx.fillStyle = o.color || '#00e5ff';
        ctx.fillText(o.label, lx, ly);
      }
      if (o.labels) for (var L = 0; L < o.labels.length; L++) {
        var lb = o.labels[L];
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
        var lx2 = SX(lb.x) + 7, ly2 = SY(lb.y) - 7;
        var tw2 = ctx.measureText(lb.text).width;
        ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(lx2 - 3, ly2 - 13, tw2 + 6, 17); ctx.restore();
        ctx.fillStyle = o.color || '#00e5ff';
        ctx.fillText(lb.text, lx2, ly2);
      }
    }
  };

  // ---------------------------------------------------------------- 命中测试
  // 按“到几何的距离”判定（不再只比顶点），更接近 AutoCAD 点选手感
  DxfRenderer.prototype.hitTest = function (sx, sy, tolPx) {
    var sp = this.active(); if (!sp) return -1;
    var w = this.screenToWorld(sx, sy);
    var tol = (tolPx || 6) / this.scale;
    var best = -1, bestD = tol;
    var ents = sp.entities;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      if (e.layer && this.visibleLayers[e.layer] === false) continue;
      var L = this.doc && this.doc.layers[e.layer];
      if (L && (L.frozen || L.locked)) continue;   // 锁定层不可选，与 AutoCAD 一致
      if (e._anc && this.ancFrozen(e)) continue;
      var bb = e._bb;
      if (bb && (w.x < bb.x0 - tol || w.x > bb.x1 + tol || w.y < bb.y0 - tol || w.y > bb.y1 + tol)) continue;
      var d = entDist(e, w);
      if (d != null && d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function entDist(e, w) {
    var md = null;
    function upd(d) { if (d != null && (md == null || d < md)) md = d; }
    switch (e.type) {
      case 'LINE': if (e.points[0] && e.points[1]) upd(segDist(w, e.points[0], e.points[1])); break;
      case 'CIRCLE': if (e.points[0]) upd(Math.abs(Math.hypot(w.x - e.points[0].x, w.y - e.points[0].y) - Math.abs(e.r40 || 0))); break;
      case 'ARC': if (e.points[0]) {
        var ang = Math.atan2(w.y - e.points[0].y, w.x - e.points[0].x) / D2R;
        var a0 = e.a50 || 0, a1 = e.a51 || 0; while (a1 <= a0) a1 += 360;
        var aa = ang; while (aa < a0) aa += 360;
        if (aa <= a1) upd(Math.abs(Math.hypot(w.x - e.points[0].x, w.y - e.points[0].y) - Math.abs(e.r40 || 0)));
        else { // 端点
          upd(Math.hypot(w.x - (e.points[0].x + e.r40 * Math.cos(a0 * D2R)), w.y - (e.points[0].y + e.r40 * Math.sin(a0 * D2R))));
          upd(Math.hypot(w.x - (e.points[0].x + e.r40 * Math.cos(a1 * D2R)), w.y - (e.points[0].y + e.r40 * Math.sin(a1 * D2R))));
        }
      } break;
      case 'LWPOLYLINE': case 'POLYLINE': case 'LEADER': {
        var v = e.vertices && e.vertices.length ? e.vertices : e.points;
        if (!v || v.length < 2) break;
        for (var i = 0; i < v.length - 1; i++) upd(segDist(w, v[i], v[i + 1]));
        if (e.f70 & 1) upd(segDist(w, v[v.length - 1], v[0]));
        break;
      }
      case 'SPLINE': {
        var c = e.ctrl && e.ctrl.length ? e.ctrl : e.fit;
        if (!c || c.length < 2) break;
        for (var k = 0; k < c.length - 1; k++) upd(segDist(w, c[k], c[k + 1]));
        break;
      }
      case 'HATCH': {
        if (!e.boundaryLoops) break;
        for (var L2 = 0; L2 < e.boundaryLoops.length; L2++) {
          var lp = e.boundaryLoops[L2];
          if (lp.vertices && lp.vertices.length > 1) {
            for (var q = 0; q < lp.vertices.length - 1; q++) upd(segDist(w, lp.vertices[q], lp.vertices[q + 1]));
            upd(segDist(w, lp.vertices[lp.vertices.length - 1], lp.vertices[0]));
          }
        }
        break;
      }
      default: {
        if (e.points) for (var p2 = 0; p2 < e.points.length; p2++) if (e.points[p2]) upd(Math.hypot(w.x - e.points[p2].x, w.y - e.points[p2].y));
        if (e.vertices) for (var p3 = 0; p3 < e.vertices.length; p3++) upd(Math.hypot(w.x - e.vertices[p3].x, w.y - e.vertices[p3].y));
      }
    }
    return md;
  }

  DxfRenderer.prototype.setSpace = function (name) {
    if (this.spaces[name]) { this.currentSpace = name; this.selected = -1; this.fit(); }
  };
  DxfRenderer.prototype._moved = function () { return this.dragMoved; };
  DxfRenderer.prototype.rebuild = function () { this.render(); };
  DxfRenderer.prototype.setActiveEntities = function (arr) {
    var sp = this.active(); if (!sp) return;
    sp.entities = arr; sp.bounds = this._computeBounds(arr); this.render();
  };
  DxfRenderer.prototype._computeBounds = function (arr) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < arr.length; i++) {
      var bb = arr[i]._bb || (arr[i]._bb = bbox(arr[i], this));
      if (bb) { if (bb.x0 < minx) minx = bb.x0; if (bb.y0 < miny) miny = bb.y0; if (bb.x1 > maxx) maxx = bb.x1; if (bb.y1 > maxy) maxy = bb.y1; }
    }
    return { x0: minx, y0: miny, x1: maxx, y1: maxy };
  };
  DxfRenderer.prototype.bboxOf = function (e) { return bbox(e, this); };

  // 字体解析对外暴露，供自检脚本判断"是否会丢字"
  function resolveFont(font, bigFont) {
    return DxfRenderer.prototype._fontFamilyFor.call({}, { font: font, bigFont: bigFont });
  }
  function fontKnown(name) {
    var k = normFontKey(name);
    return !!(k && SHX_SUBST[k]);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DxfRenderer: DxfRenderer, bbox: bbox, stripMtext: stripMtext,
      resolveFont: resolveFont, fontKnown: fontKnown, normFontKey: normFontKey, SHX_SUBST: SHX_SUBST
    };
  } else {
    global.DxfRenderer = DxfRenderer; global.DxfBBox = bbox;
    global.DxfFont = { resolveFont: resolveFont, fontKnown: fontKnown };
  }
})(typeof window !== 'undefined' ? window : this);
