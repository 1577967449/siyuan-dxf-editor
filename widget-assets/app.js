/* =============================================================
 * app.js —— DXF 浏览器编辑器 UI 层（对齐 AutoCAD 操作习惯）
 *   · 图层：开/关(💡)  冻结(❄)  锁定(🔒)  颜色
 *   · 图层前缀分组：按 - _ $ / 及中/英文分界自动归组，整组开关
 *   · 布局标签：模型 / 布局1 / 布局2 …（AutoCAD 底部标签）
 *   · 十字光标(CROSSHAIR)、坐标读数、F3 捕捉、F8 正交、Esc 取消
 *   · 工具：选择 / 直线 / 圆 / 文字 / 距离 / 周长面积 / 框选文字（含周边）
 *   · 对象捕捉：端点 / 中点 / 圆心 / 垂足 / 最近点 / 相切 / 交点
 * ============================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------- DOM
  var $ = function (id) { return document.getElementById(id); };
  var cv = $('cv'), ov = $('overlay'), stage = cv.parentNode;
  var elLayers = $('layers'), elGroups = $('groups'), elTexts = $('texts');
  var elTabs = $('layoutTabs'), elXY = $('xy'), elCur = $('curLayer');
  var elStatus = $('status'), elHint = $('hint');
  var elSelEmpty = $('selEmpty'), elSelActions = $('selActions'), elSelLayer = $('selLayer'), elArea = $('areaInfo');

  var R = new DxfRenderer(cv);
  window.R = R;   // 方便调试与外部脚本调用
  var octx = ov.getContext('2d');

  var S = {
    doc: null,
    mode: 'select',
    pts: [],                 // 当前命令的拾取点
    ortho: false,
    snapOn: true,
    cursor: null,            // 屏幕坐标
    curLayer: '0',
    added: [],               // 本次会话新增的实体（导出时写回）
    fileName: 'drawing.dxf',
    groupState: {},          // 分组折叠状态
    boxSel: null,            // 文字框选：拖拽中的橡皮筋矩形（屏幕坐标）
    boxHilite: []            // 文字框选：命中实体在 activeEntities 中的下标
  };

  function say(msg) { elStatus.textContent = msg; }
  function hint(msg) { elHint.textContent = msg || ''; }

  // ---------------------------------------------------------------- 画布尺寸
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    [cv, ov].forEach(function (c) {
      var w = stage.clientWidth, h = stage.clientHeight;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + 'px'; c.style.height = h + 'px';
    });
    R.dpr = dpr;
    if (S.doc) R.render();
    drawOverlayUI();
  }
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------------- 十字光标 / 捕捉标记
  function drawOverlayUI() {
    var dpr = window.devicePixelRatio || 1;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = stage.clientWidth, h = stage.clientHeight;
    octx.clearRect(0, 0, w, h);
    if (!S.cursor) return;
    var x = S.cursor.x, y = S.cursor.y;

    // AutoCAD 全屏十字光标
    octx.strokeStyle = 'rgba(190,190,190,0.55)';
    octx.lineWidth = 1;
    octx.beginPath();
    octx.moveTo(0, Math.round(y) + 0.5); octx.lineTo(w, Math.round(y) + 0.5);
    octx.moveTo(Math.round(x) + 0.5, 0); octx.lineTo(Math.round(x) + 0.5, h);
    octx.stroke();
    // 拾取框
    octx.strokeStyle = 'rgba(230,230,230,0.9)';
    octx.strokeRect(Math.round(x) - 5.5, Math.round(y) - 5.5, 11, 11);

    // 捕捉标记（AutoCAD 用洋红/黄绿方框）
    if (R.snapPoint) {
      var sp = R.worldToScreen(R.snapPoint.x, R.snapPoint.y);
      octx.strokeStyle = '#ffe000'; octx.lineWidth = 2;
      var t = R.snapPoint.type;
      if (t === 'center') { octx.beginPath(); octx.arc(sp.x, sp.y, 6, 0, Math.PI * 2); octx.stroke(); }
      else if (t === 'mid') { octx.beginPath(); octx.moveTo(sp.x - 6, sp.y + 5); octx.lineTo(sp.x + 6, sp.y + 5); octx.lineTo(sp.x, sp.y - 6); octx.closePath(); octx.stroke(); }
      else if (t === 'intersect') { octx.beginPath(); octx.moveTo(sp.x - 5, sp.y - 5); octx.lineTo(sp.x + 5, sp.y + 5); octx.moveTo(sp.x + 5, sp.y - 5); octx.lineTo(sp.x - 5, sp.y + 5); octx.stroke(); }
      else if (t === 'perp') { octx.beginPath(); octx.moveTo(sp.x - 6, sp.y); octx.lineTo(sp.x, sp.y); octx.lineTo(sp.x, sp.y - 6); octx.stroke(); }
      else if (t === 'nearest') { octx.beginPath(); octx.arc(sp.x, sp.y, 4, 0, Math.PI * 2); octx.fillStyle = '#ffe000'; octx.fill(); }
      else if (t === 'tangent') { octx.beginPath(); octx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); octx.stroke(); octx.beginPath(); octx.moveTo(sp.x + 6, sp.y - 7); octx.lineTo(sp.x + 12, sp.y + 5); octx.stroke(); }
      else { octx.strokeRect(sp.x - 5, sp.y - 5, 10, 10); }
    }

    // 命令进行中的橡皮筋预览
    if (S.pts.length) {
      var wp = rubberTarget();
      octx.strokeStyle = '#00e5ff'; octx.lineWidth = 1.2;
      octx.setLineDash([5, 4]);
      octx.beginPath();
      for (var i = 0; i < S.pts.length; i++) {
        var q = R.worldToScreen(S.pts[i].x, S.pts[i].y);
        if (i === 0) octx.moveTo(q.x, q.y); else octx.lineTo(q.x, q.y);
      }
      if (wp) {
        var lastW = S.pts[S.pts.length - 1];
        if (S.mode === 'draw-circle') {
          var r = Math.hypot(wp.x - S.pts[0].x, wp.y - S.pts[0].y) * R.scale;
          var c0 = R.worldToScreen(S.pts[0].x, S.pts[0].y);
          octx.setLineDash([5, 4]);
          octx.beginPath(); octx.arc(c0.x, c0.y, r, 0, Math.PI * 2); octx.stroke();
        } else {
          var t2 = R.worldToScreen(wp.x, wp.y);
          octx.lineTo(t2.x, t2.y); octx.stroke();
          // 长度/角度动态提示（AutoCAD 动态输入）
          var d = Math.hypot(wp.x - lastW.x, wp.y - lastW.y);
          var ang = Math.atan2(wp.y - lastW.y, wp.x - lastW.x) * 180 / Math.PI;
          if (ang < 0) ang += 360;
          octx.setLineDash([]);
          var lbl = fmt(d) + '  ' + ang.toFixed(1) + '°';
          octx.font = '12px "Microsoft YaHei", sans-serif';
          var tw = octx.measureText(lbl).width;
          octx.fillStyle = 'rgba(0,0,0,.75)'; octx.fillRect(x + 14, y + 10, tw + 8, 18);
          octx.fillStyle = '#ffe000'; octx.fillText(lbl, x + 18, y + 23);
        }
      } else octx.stroke();
      octx.setLineDash([]);
    }

    // 文字框选：高亮命中的文字包围盒
    if (S.boxHilite && S.boxHilite.length) {
      octx.strokeStyle = 'rgba(80,220,120,0.95)'; octx.lineWidth = 1.5;
      var hl = R.activeEntities();
      for (var h = 0; h < S.boxHilite.length; h++) {
        var he = hl[S.boxHilite[h]]; if (!he || !he._bb) continue;
        var ha = R.worldToScreen(he._bb.x0, he._bb.y1), hb = R.worldToScreen(he._bb.x1, he._bb.y0);
        octx.strokeRect(ha.x, ha.y, hb.x - ha.x, hb.y - ha.y);
      }
    }
    // 文字框选：拖拽中的橡皮筋矩形
    if (S.boxSel) {
      var bx = Math.min(S.boxSel.x0, S.boxSel.x1), by = Math.min(S.boxSel.y0, S.boxSel.y1);
      var bw = Math.abs(S.boxSel.x1 - S.boxSel.x0), bh = Math.abs(S.boxSel.y1 - S.boxSel.y0);
      octx.fillStyle = 'rgba(43,125,233,0.12)'; octx.fillRect(bx, by, bw, bh);
      octx.strokeStyle = '#2b7de9'; octx.lineWidth = 1; octx.setLineDash([4, 3]);
      octx.strokeRect(bx, by, bw, bh); octx.setLineDash([]);
    }
  }

  // 正交约束 + 捕捉后的目标点
  function rubberTarget() {
    if (!S.cursor) return null;
    var w = R.snapPoint || R.screenToWorld(S.cursor.x, S.cursor.y);
    if (S.ortho && S.pts.length) {
      var a = S.pts[S.pts.length - 1];
      if (Math.abs(w.x - a.x) > Math.abs(w.y - a.y)) w = { x: w.x, y: a.y };
      else w = { x: a.x, y: w.y };
    }
    return w;
  }

  function fmt(v) {
    var a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(3);
    return v.toFixed(a >= 100 ? 1 : 3);
  }

  // ---------------------------------------------------------------- 对象捕捉（端点/中点/圆心/交点）
  // 实体 → 线段集合，用于求交。支持 LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC / ELLIPSE
  function entitySegments(e) {
    var segs = [];
    function push(a, b) {
      if (a && b && isFinite(a.x) && isFinite(a.y) && isFinite(b.x) && isFinite(b.y)) segs.push({ a: a, b: b });
    }
    if (e.type === 'LINE') {
      push(e.points && e.points[0], e.points && e.points[1]);
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      var v = e.vertices || e.points || [];
      if (v.length >= 2) {
        for (var i = 0; i + 1 < v.length; i++) push(v[i], v[i + 1]);
        if ((e.f70 & 1) || e.closed) push(v[v.length - 1], v[0]);
      }
    } else if (e.type === 'CIRCLE') {
      var c = e.points && e.points[0], r = e.r40, N = 48;
      if (c && r) for (var k = 0; k < N; k++) {
        var a0 = k / N * 2 * Math.PI, a1 = (k + 1) / N * 2 * Math.PI;
        push({ x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) }, { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) });
      }
    } else if (e.type === 'ARC') {
      var c2 = e.points && e.points[0], r2 = e.r40;
      if (c2 && r2) {
        var s2 = (e.a50 || 0) * Math.PI / 180, e2 = (e.a51 || 0) * Math.PI / 180;
        if (e2 < s2) e2 += 2 * Math.PI;
        var N2 = 48, span = e2 - s2;
        for (var m = 0; m < N2; m++) {
          var t0 = s2 + span * m / N2, t1 = s2 + span * (m + 1) / N2;
          push({ x: c2.x + r2 * Math.cos(t0), y: c2.y + r2 * Math.sin(t0) }, { x: c2.x + r2 * Math.cos(t1), y: c2.y + r2 * Math.sin(t1) });
        }
      }
    } else if (e.type === 'ELLIPSE') {
      var c3 = e.points && e.points[0];
      if (c3) {
        var mx = (e._majX != null ? e._majX : (e.points[1] ? e.points[1].x : 0));
        var my = (e._majY != null ? e._majY : (e.points[1] ? e.points[1].y : 0));
        var maj = Math.hypot(mx, my), rot = Math.atan2(my, mx), min = maj * (e.r40 || 1);
        var ps = (e.a50 || 0), pe = (e.a51 || 2 * Math.PI); if (pe < ps) pe += 2 * Math.PI;
        var N3 = 48, span3 = pe - ps;
        function ell(t) { var cx = maj * Math.cos(t), cy = min * Math.sin(t); return { x: c3.x + cx * Math.cos(rot) - cy * Math.sin(rot), y: c3.y + cx * Math.sin(rot) + cy * Math.cos(rot) }; }
        for (var n = 0; n < N3; n++) { var u0 = ps + span3 * n / N3, u1 = ps + span3 * (n + 1) / N3; push(ell(u0), ell(u1)); }
      }
    }
    return segs;
  }

  // 线段 p1-p2 与 p3-p4 的真实交点（两端参数都在 [0,1] 内才算相交）
  function segIntersect(p1, p2, p3, p4) {
    var d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-12) return null;
    var t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    var u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }

  // 点 P 到线段 AB 的垂足（仅当垂足落在线段内时返回）
  function projectPointOnSegment(P, A, B) {
    var dx = B.x - A.x, dy = B.y - A.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return null;
    var t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
    if (t < -1e-9 || t > 1 + 1e-9) return null;
    return { x: A.x + t * dx, y: A.y + t * dy };
  }

  // 点 P 到线段 AB 的最近点
  function closestPointOnSegment(P, A, B) {
    var dx = B.x - A.x, dy = B.y - A.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return A;
    var t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
    return { x: A.x + t * dx, y: A.y + t * dy };
  }

  // 从外部点 P 到圆(C,r)的切点；P 在圆内时返回空
  function tangentPointsToCircle(P, C, r) {
    var dx = P.x - C.x, dy = P.y - C.y;
    var d2 = dx * dx + dy * dy;
    if (d2 < r * r) return [];
    if (d2 < 1e-18) return [];
    var d = Math.sqrt(d2);
    if (Math.abs(d - r) < 1e-9) return [{ x: P.x, y: P.y }];
    var base = Math.atan2(dy, dx);
    var ang = Math.acos(r / d);
    return [
      { x: C.x + r * Math.cos(base + ang), y: C.y + r * Math.sin(base + ang) },
      { x: C.x + r * Math.cos(base - ang), y: C.y + r * Math.sin(base - ang) }
    ];
  }

  function computeSnap(sx, sy) {
    if (!S.snapOn || !S.doc) { R.snapPoint = null; return; }
    var tolPx = 12, tol = tolPx / R.scale;
    var w = R.screenToWorld(sx, sy);
    var ents = R.activeEntities();
    var best = null, bestD = tol;
    var vb = R.viewBounds();
    function cand(p, type) {
      if (!p) return;
      var d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y, type: type }; }
    }
    // 收集光标附近（视图裁剪框内）的实体，供端点/中点/圆心与交点捕捉复用
    var near = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e._degenerate) continue;
      var L = S.doc.layers[e.layer];
      if (L && (L.frozen || R.visibleLayers[e.layer] === false)) continue;
      if (e._anc && R.ancFrozen(e)) continue;
      var b = e._bb;
      if (b && (b.x1 < vb.x0 - tol || b.x0 > vb.x1 + tol || b.y1 < vb.y0 - tol || b.y0 > vb.y1 + tol)) continue;
      near.push(e);
      if (e.type === 'CIRCLE' || e.type === 'ARC') { cand(e.points && e.points[0], 'center'); }
      var pl = e.vertices || e.points;
      if (pl) for (var j = 0; j < pl.length; j++) {
        cand(pl[j], 'endpoint');
        if (j + 1 < pl.length) cand({ x: (pl[j].x + pl[j + 1].x) / 2, y: (pl[j].y + pl[j + 1].y) / 2 }, 'mid');
      }
    }
    // 线段级捕捉：垂足 / 最近点 / 相切 / 交点
    if (near.length && near.length <= 50) {
      var segs = [];
      for (var ni = 0; ni < near.length; ni++) {
        var es = entitySegments(near[ni]);
        if (es.length > 200) es = es.slice(0, 200);   // 巨型多段线限段，避免卡顿
        for (var si = 0; si < es.length; si++) segs.push({ e: near[ni], s: es[si] });
      }
      if (segs.length <= 2200) {
        // 垂足 + 最近点：对每条线段计算一次
        for (var si = 0; si < segs.length; si++) {
          var seg = segs[si].s, A = seg.a, B = seg.b;
          var perp = projectPointOnSegment(w, A, B);
          if (perp) cand(perp, 'perp');
          cand(closestPointOnSegment(w, A, B), 'nearest');
        }
        // 相切：仅对圆/弧
        for (var ci = 0; ci < near.length; ci++) {
          var e = near[ci];
          if (e.type !== 'CIRCLE' && e.type !== 'ARC') continue;
          var c = e.points && e.points[0], r = e.r40;
          if (!c || !(r > 0)) continue;
          var tps = tangentPointsToCircle(w, c, r);
          for (var ti = 0; ti < tps.length; ti++) cand(tps[ti], 'tangent');
        }
        // 交点：不同实体之间
        for (var a = 0; a < segs.length; a++) {
          for (var c = a + 1; c < segs.length; c++) {
            if (segs[a].e === segs[c].e) continue;     // 同实体自交不计
            var ip = segIntersect(segs[a].s.a, segs[a].s.b, segs[c].s.a, segs[c].s.b);
            if (ip) cand(ip, 'intersect');
          }
        }
      }
    }
    R.snapPoint = best;
  }

  // ---------------------------------------------------------------- 鼠标
  cv.addEventListener('mousemove', function (ev) {
    var r = cv.getBoundingClientRect();
    S.cursor = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (S.boxSel) { S.boxSel.x1 = S.cursor.x; S.boxSel.y1 = S.cursor.y; }
    computeSnap(S.cursor.x, S.cursor.y);
    var w = R.snapPoint || R.screenToWorld(S.cursor.x, S.cursor.y);
    elXY.textContent = fmt(w.x) + ', ' + fmt(w.y);
    drawOverlayUI();
  });
  cv.addEventListener('mouseleave', function () { S.cursor = null; R.snapPoint = null; drawOverlayUI(); });

  cv.addEventListener('click', function (ev) {
    if (ev.button !== 0) return;
    if (R._moved()) return;                      // 刚才是平移，不当点击
    if (S.mode === 'sel-text') return;          // 框选文字用拖拽，单击不拾取
    if (!S.doc) { say('请先打开一个 DXF 文件。'); return; }
    var r = cv.getBoundingClientRect();
    var sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    computeSnap(sx, sy);
    var wp = R.snapPoint || R.screenToWorld(sx, sy);
    if (S.ortho && S.pts.length) {
      var a = S.pts[S.pts.length - 1];
      if (Math.abs(wp.x - a.x) > Math.abs(wp.y - a.y)) wp = { x: wp.x, y: a.y }; else wp = { x: a.x, y: wp.y };
    }
    handlePick(sx, sy, wp);
  });

  // ---- 文字框选（与广联达快速看图一致：拖框识别区域内文字，含嵌套块）----
  var boxStart = null;
  cv.addEventListener('mousedown', function (ev) {
    if (S.mode !== 'sel-text' || ev.button !== 0) return;
    var r = cv.getBoundingClientRect();
    boxStart = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    S.boxSel = { x0: boxStart.x, y0: boxStart.y, x1: boxStart.x, y1: boxStart.y };
    drawOverlayUI();
  });
  window.addEventListener('mouseup', function (ev) {
    if (!S.boxSel || !boxStart) { boxStart = null; return; }
    var sel = S.boxSel; boxStart = null; S.boxSel = null;
    var dx = Math.abs(sel.x1 - sel.x0), dy = Math.abs(sel.y1 - sel.y0);
    if (dx < 4 && dy < 4) { clearTextPick(); drawOverlayUI(); return; }   // 视为单击：取消
    finalizeTextPick(sel);
    drawOverlayUI();
  });

  function clearTextPick() {
    S.boxHilite = [];
    var p = $('txtPick'); if (p) p.classList.add('hidden');
  }

  function finalizeTextPick(sel) {
    if (!S.doc) return;
    var x0 = Math.min(sel.x0, sel.x1), x1 = Math.max(sel.x0, sel.x1);
    var y0 = Math.min(sel.y0, sel.y1), y1 = Math.max(sel.y0, sel.y1);
    var tl = R.screenToWorld(x0, y0), br = R.screenToWorld(x1, y1);   // 屏幕左上/右下 -> 世界
    var wr = { x0: Math.min(tl.x, br.x), y0: Math.min(tl.y, br.y), x1: Math.max(tl.x, br.x), y1: Math.max(tl.y, br.y) };
    var ents = R.activeEntities();
    var res = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.type !== 'TEXT' && e.type !== 'MTEXT' && e.type !== 'ATTRIB') continue;
      var bb = e._bb; if (!bb) continue;
      // 仅识别用户实际框选范围内的文字：包围盒与框选矩形相交。
      var hit = !(bb.x1 < wr.x0 || bb.x0 > wr.x1 || bb.y1 < wr.y0 || bb.y0 > wr.y1);
      if (hit) res.push({ i: i, e: e });
    }
    S.boxHilite = res.map(function (r) { return r.i; });
    showTextPick(res, x1, y0);
  }

  function showTextPick(res, px, py) {
    var p = $('txtPick');
    if (!res.length) { say('框选区域内无文字。'); clearTextPick(); return; }
    // 按阅读顺序排列：自上而下、同行自左而右
    var rows = readingOrderRows(res);
    var all = rows.map(function (row) { return row.map(function (r) { return cleanText(r.e.text); }).join(' '); }).join('\n');
    var count = res.length;
    var html = '';
    html += '<div class="hd"><b>框选文字 ' + count + ' 条</b><span class="sp"></span>'
      + '<button id="tpCopy">复制全部</button>'
      + '<button id="tpExp">导出</button>'
      + '<button id="tpClose">关闭</button></div>';
    html += '<textarea id="tpArea" readonly>' + escapeHtml(all) + '</textarea>';
    p.innerHTML = html;
    p.classList.remove('hidden');
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.min(px + 12, vw - 360), top = Math.min(py, vh - 80);
    if (left < 4) left = 4; if (top < 4) top = 4;
    p.style.left = left + 'px'; p.style.top = top + 'px';
    $('tpClose').onclick = function () { clearTextPick(); drawOverlayUI(); };
    $('tpCopy').onclick = function () {
      var area = $('tpArea'); area.select(); copyText(all);
    };
    $('tpExp').onclick = function () {
      var blob = new Blob([all], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = (S.fileName || '提取文字').replace(/\.dxf$/i, '') + '_框选.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      say('已导出 ' + count + ' 条框选文字。');
    };
    // 用户已可在 textarea 里自由拖动选中再 Ctrl+C；同时框完自动复制一次
    copyText(all);
  }

  // 阅读顺序：先按竖向（上到下，Y 越大越靠上）分“行”，行内再按 X 从左到右
  function readingOrderRows(res) {
    // 计算每个文字的中心与大致高度
    var items = res.map(function (r) {
      var bb = r.e._bb || {};
      var cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      var h = Math.abs(bb.y1 - bb.y0) || (r.e.r40 || 2.5);
      return { r: r, cx: cx, cy: cy, h: h };
    });
    // 按 Y 从大到小（从上到下）排序
    items.sort(function (a, b) { return b.cy - a.cy; });
    var rows = [], cur = null, tol = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!cur) { cur = { y: it.cy, h: it.h, items: [it] }; tol = it.h * 0.7; }
      else if (Math.abs(it.cy - cur.y) <= tol) { cur.items.push(it); cur.y = (cur.y * (cur.items.length - 1) + it.cy) / cur.items.length; }
      else { rows.push(cur); cur = { y: it.cy, h: it.h, items: [it] }; tol = it.h * 0.7; }
    }
    if (cur) rows.push(cur);
    // 每行内按 X 从左到右
    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.cx - b.cx; });
    });
    return rows.map(function (row) { return row.items.map(function (it) { return it.r; }); });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------------------------------------------------------------- 命令派发
  function handlePick(sx, sy, wp) {
    switch (S.mode) {
      case 'select': {
        var idx = R.hitTest(sx, sy, 7);
        R.selected = idx;
        R.render(); showSel();
        break;
      }
      case 'draw-line':
        S.pts.push(wp);
        if (S.pts.length === 2) { addEnt({ type: 'LINE', layer: S.curLayer, points: [S.pts[0], S.pts[1]] }); S.pts = []; hint('直线：指定第一点'); }
        else hint('直线：指定下一点（Esc 结束）');
        break;
      case 'draw-circle':
        S.pts.push(wp);
        if (S.pts.length === 2) {
          var rad = Math.hypot(S.pts[1].x - S.pts[0].x, S.pts[1].y - S.pts[0].y);
          addEnt({ type: 'CIRCLE', layer: S.curLayer, points: [S.pts[0]], r40: rad });
          S.pts = []; hint('圆：指定圆心');
        } else hint('圆：指定半径');
        break;
      case 'draw-text': {
        var t = window.prompt('输入文字内容：', '');
        if (t) {
          var hh = window.prompt('文字高度：', String(defaultTextHeight()));
          addEnt({ type: 'TEXT', layer: S.curLayer, points: [wp], text: t, r40: parseFloat(hh) || defaultTextHeight(), r50: 0, style: 'Standard' });
        }
        break;
      }
      case 'm-dist':
        S.pts.push(wp);
        if (S.pts.length === 2) {
          var d = Math.hypot(S.pts[1].x - S.pts[0].x, S.pts[1].y - S.pts[0].y);
          var ang = Math.atan2(S.pts[1].y - S.pts[0].y, S.pts[1].x - S.pts[0].x) * 180 / Math.PI;
          R.overlays.push({ kind: 'seg', a: S.pts[0], b: S.pts[1], color: '#00e5ff', label: '距离 ' + fmt(d) + '  ' + ang.toFixed(2) + '°' });
          say('距离 = ' + fmt(d) + '（Δx=' + fmt(S.pts[1].x - S.pts[0].x) + ' Δy=' + fmt(S.pts[1].y - S.pts[0].y) + '）');
          S.pts = []; R.render();
        } else hint('距离：指定第二点');
        break;
      case 'm-area':
        S.pts.push(wp);
        hint('周长面积：继续拾点，双击/回车闭合（已 ' + S.pts.length + ' 点）');
        break;
    }
    drawOverlayUI();
  }

  cv.addEventListener('dblclick', function (ev) {
    if (ev.button !== 0) return;
    if (S.mode === 'm-area' && S.pts.length >= 3) finishAreaPoly();
  });

  function finishAreaPoly() {
    var A = polyArea(S.pts), Pm = polyPerim(S.pts, true);
    R.overlays.push({ kind: 'poly', pts: S.pts.slice(), close: true, fill: true, color: '#4ade80', label: '面积 ' + fmt(Math.abs(A)) + '  周长 ' + fmt(Pm) });
    say('多边形面积 = ' + fmt(Math.abs(A)) + '，周长 = ' + fmt(Pm));
    S.pts = []; R.render(); drawOverlayUI(); hint('周长面积：拾第一点');
  }

  function defaultTextHeight() {
    if (S.doc && S.doc.textsize > 0) return S.doc.textsize;
    var sp = R.active(); if (!sp) return 2.5;
    var b = sp.rbounds || sp.bounds;
    return Math.max(0.5, (b.x1 - b.x0) / 200);
  }

  function addEnt(e) {
    e.handle = 'A' + (Date.now().toString(16)) + (S.added.length);
    e._new = true;
    var sp = R.active();
    sp.entities.push(e);
    e._bb = R.bboxOf(e);
    S.added.push(e);
    R.render();
    say('已新增 ' + e.type + '（图层 ' + e.layer + '）。累计新增 ' + S.added.length + ' 个。');
  }

  // ---------------------------------------------------------------- 几何辅助
  function entityLoop(e) {
    if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      var v = e.vertices || []; if (v.length < 3) return null;
      return v.map(function (p) { return { x: p.x, y: p.y }; });
    }
    if (e.type === 'CIRCLE') {
      var c = e.points[0], r = e.r40, out = [];
      for (var i = 0; i < 72; i++) { var a = i / 72 * Math.PI * 2; out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
      return out;
    }
    if (e.type === 'ELLIPSE') {
      var c2 = e.points[0], mx = (e._majX != null ? e._majX : e.points[1].x), my = (e._majY != null ? e._majY : e.points[1].y);
      var maj = Math.hypot(mx, my), rot = Math.atan2(my, mx), min = maj * (e.r40 || 1), o2 = [];
      for (var k = 0; k < 72; k++) {
        var t = k / 72 * Math.PI * 2, cx = maj * Math.cos(t), cy = min * Math.sin(t);
        o2.push({ x: c2.x + cx * Math.cos(rot) - cy * Math.sin(rot), y: c2.y + cx * Math.sin(rot) + cy * Math.cos(rot) });
      }
      return o2;
    }
    if (e.type === 'HATCH' && e.boundaryLoops && e.boundaryLoops.length) {
      var lp = e.boundaryLoops[0];
      if (lp.vertices && lp.vertices.length >= 3) return lp.vertices.map(function (p) { return { x: p.x, y: p.y }; });
    }
    if (e.type === 'SOLID' && e.points && e.points.length >= 3) {
      var o = [e.points[0], e.points[1], e.points[3] || e.points[2], e.points[2]].filter(Boolean);
      return o.map(function (p) { return { x: p.x, y: p.y }; });
    }
    return null;
  }
  function polyArea(p) { var s = 0; for (var i = 0, n = p.length; i < n; i++) { var a = p[i], b = p[(i + 1) % n]; s += a.x * b.y - b.x * a.y; } return s / 2; }
  function polyPerim(p, close) { var s = 0; for (var i = 0; i + 1 < p.length; i++) s += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y); if (close && p.length > 2) s += Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y); return s; }

  function applyMat(e, M) {
    function tp(p) { var x = M.a * p.x + M.c * p.y + M.e, y = M.b * p.x + M.d * p.y + M.f; p.x = x; p.y = y; }
    if (e.points) e.points.forEach(tp);
    if (e.vertices) e.vertices.forEach(function (v) { tp(v); if (v.bulge) v.bulge = -v.bulge; });
    if (e.ctrl) e.ctrl.forEach(tp);
    if (e.fit) e.fit.forEach(tp);
    if (e.boundaryLoops) e.boundaryLoops.forEach(function (lp) { if (lp.vertices) lp.vertices.forEach(tp); });
    if (e.type === 'TEXT' || e.type === 'MTEXT') e.r50 = 180 - (e.r50 || 0);
  }

  // ---------------------------------------------------------------- 图层面板
  function layerPrefix(name) {
    var n = String(name);
    // 1) 显式分隔符：A-XREF → A ；TCH_ELEVATION → TCH ；$Building$0$墙 → $Building
    var m = n.match(/^([^\-_$|/\\]{1,20})[\-_$|/\\]/);
    if (m && m[1]) return m[1];
    // 2) 中文前缀：动力照明 → 动力（取前 2 字）；纯中文短名整体作组
    if (/^[\u4e00-\u9fa5]/.test(n)) return n.length <= 3 ? n : n.slice(0, 2);
    // 3) 字母+数字：DIM10 → DIM
    var m2 = n.match(/^([A-Za-z]{1,10})\d/);
    if (m2) return m2[1].toUpperCase();
    return n.length > 4 ? n.slice(0, 3).toUpperCase() : n;
  }

  function layerState(ln) {
    var L = S.doc.layers[ln] || {};
    return { off: R.visibleLayers[ln] === false, frozen: !!L.frozen, locked: !!L.locked };
  }

  function buildLayers() {
    elLayers.innerHTML = ''; elGroups.innerHTML = '';
    if (!S.doc) return;
    var names = Object.keys(S.doc.layers).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    // 统计每层实体数（当前空间）
    var cnt = {};
    R.activeEntities().forEach(function (e) { cnt[e.layer] = (cnt[e.layer] || 0) + 1; });

    var frag = document.createDocumentFragment();
    names.forEach(function (ln) {
      frag.appendChild(layerRow(ln, cnt[ln] || 0));
    });
    elLayers.appendChild(frag);

    // ---- 前缀分组 ----
    var groups = {};
    names.forEach(function (ln) { var p = layerPrefix(ln); (groups[p] = groups[p] || []).push(ln); });
    var keys = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length || a.localeCompare(b, 'zh'); });
    var gf = document.createDocumentFragment();
    keys.forEach(function (k) {
      var arr = groups[k];
      var total = arr.reduce(function (s, ln) { return s + (cnt[ln] || 0); }, 0);
      var row = document.createElement('div');
      row.className = 'row';
      var allOn = arr.every(function (ln) { return R.visibleLayers[ln] !== false; });
      var bulb = document.createElement('span');
      bulb.className = 'tog ' + (allOn ? 'on' : 'off'); bulb.textContent = allOn ? '💡' : '·';
      bulb.title = '整组 开/关';
      bulb.onclick = function () {
        var turnOn = !allOn;
        arr.forEach(function (ln) { R.visibleLayers[ln] = turnOn; });
        R.render(); buildLayers();
      };
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = k + '  (' + arr.length + '层 / ' + total + '个)';
      nm.style.color = allOn ? '#7fcf7f' : '#666';
      nm.style.cursor = 'pointer';
      nm.title = arr.join('\n');
      nm.onclick = function () {
        S.groupState[k] = !S.groupState[k];
        buildLayers();
      };
      row.appendChild(bulb); row.appendChild(nm);
      gf.appendChild(row);
      if (S.groupState[k]) {
        arr.forEach(function (ln) {
          var sub = layerRow(ln, cnt[ln] || 0);
          sub.style.paddingLeft = '18px'; sub.style.opacity = '.9';
          gf.appendChild(sub);
        });
      }
    });
    elGroups.appendChild(gf);

    // 属性面板的图层下拉
    elSelLayer.innerHTML = '';
    names.forEach(function (ln) { var o = document.createElement('option'); o.value = ln; o.textContent = ln; elSelLayer.appendChild(o); });
  }

  function layerRow(ln, n) {
    var L = S.doc.layers[ln] || {};
    var st = layerState(ln);
    var row = document.createElement('div'); row.className = 'row';

    var bulb = document.createElement('span');
    bulb.className = 'tog ' + (st.off ? 'off' : 'on'); bulb.textContent = st.off ? '·' : '💡';
    bulb.title = '开/关 (ON/OFF)';
    bulb.onclick = function () { R.visibleLayers[ln] = st.off; R.render(); buildLayers(); };

    var frz = document.createElement('span');
    frz.className = 'tog ' + (st.frozen ? 'on' : 'off'); frz.textContent = st.frozen ? '❄' : '☀';
    frz.title = '冻结 (FREEZE)';
    frz.onclick = function () { L.frozen = !L.frozen; R.render(); buildLayers(); };

    var lk = document.createElement('span');
    lk.className = 'tog ' + (st.locked ? 'on' : 'off'); lk.textContent = st.locked ? '🔒' : '🔓';
    lk.title = '锁定 (LOCK)';
    lk.onclick = function () { L.locked = !L.locked; R.render(); buildLayers(); };

    var sw = document.createElement('span'); sw.className = 'swatch';
    sw.style.background = L.trueColor || DxfParser.aciColor(L.color) || '#ffffff';
    sw.title = 'ACI ' + (L.color != null ? Math.abs(L.color) : '?');

    var nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = ln + (n ? '  (' + n + ')' : '');
    nm.style.color = st.off || st.frozen ? '#666' : '#d6d6d6';
    if (ln === S.curLayer) { nm.style.fontWeight = 'bold'; nm.style.color = '#9fd3ff'; }
    nm.style.cursor = 'pointer';
    nm.title = '双击设为当前层';
    nm.ondblclick = function () { S.curLayer = ln; elCur.textContent = ln; buildLayers(); };

    row.appendChild(bulb); row.appendChild(frz); row.appendChild(lk); row.appendChild(sw); row.appendChild(nm);
    return row;
  }

  // ---------------------------------------------------------------- 文字面板
  // 清理 MTEXT/TEXT 里的格式代码，便于复制/导出（与「快速看图」文字提取一致）
  function cleanText(t) {
    if (t == null) return '';
    return String(t)
      .replace(/\\P/g, '\n').replace(/\\p/g, '\n')   // 段落
      .replace(/\\\\/g, '\\')                          // 转义反斜杠
      .replace(/\\\{/g, '{').replace(/\\\}/g, '}')     // 转义花括号
      .replace(/\\[A-Za-z][^;{}]*;?/g, '')             // 字体/字高/颜色等格式码 \f \H \C \L ...
      .replace(/[{}]/g, '')                            // 残余分组花括号
      .replace(/[ \t]+$/gm, '');
  }
  function copyText(t) {
    var s = cleanText(t);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s); say('已复制文字到剪贴板。'); return;
      }
    } catch (e) {}
    var ta = document.createElement('textarea');
    ta.value = s; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); say('已复制文字到剪贴板。'); }
    catch (e) { say('复制失败，请手动选择。'); }
    document.body.removeChild(ta);
  }

  function buildTexts() {
    elTexts.innerHTML = '';
    if (!S.doc) return;
    var arr = R.activeEntities().filter(function (e) { return (e.type === 'TEXT' || e.type === 'MTEXT') && e.text; });
    var head = document.createElement('div'); head.className = 'row txtrow';
    head.innerHTML = '<span class="nm" style="color:#9fd3ff">共 ' + arr.length + ' 条文字</span>';
    elTexts.appendChild(head);
    if (arr.length) {
      var bar = document.createElement('div'); bar.className = 'row txtrow'; bar.style.gap = '6px'; bar.style.marginBottom = '3px';
      var bExport = document.createElement('button'); bExport.textContent = '导出全部文字';
      bExport.onclick = function () {
        var lines = arr.map(function (e) {
          return '【' + (e.layer || '') + '】 ' + cleanText(e.text);
        });
        var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = (S.fileName || '提取文字').replace(/\.dxf$/i, '') + '_文字.txt';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        say('已导出 ' + arr.length + ' 条文字。');
      };
      var bCopy = document.createElement('button'); bCopy.textContent = '复制全部';
      bCopy.onclick = function () {
        copyText(arr.map(function (e) { return cleanText(e.text); }).join('\n'));
      };
      bar.appendChild(bExport); bar.appendChild(bCopy);
      elTexts.appendChild(bar);
    }
    var frag = document.createDocumentFragment();
    arr.slice(0, 600).forEach(function (e) {
      var row = document.createElement('div'); row.className = 'row txtrow';
      var cp = document.createElement('span'); cp.textContent = '复制'; cp.title = '复制此条文字';
      cp.style.cssText = 'flex:0 0 auto;font-size:10px;color:#7fe0a0;cursor:pointer;padding:0 4px;border:1px solid #3a5;border-radius:3px;';
      cp.onclick = function (ev) { ev.stopPropagation(); copyText(e.text); };
      var nm = document.createElement('span'); nm.className = 'nm';
      var t = String(e.text).replace(/\\P/g, ' ').replace(/\{|\}/g, '').slice(0, 40);
      nm.textContent = t;
      nm.title = e.text + '\n图层: ' + e.layer + '\n样式: ' + (e.style || '') + '\n高: ' + (e.r40 || 0);
      nm.style.cursor = 'pointer';
      nm.onclick = function () {
        var p = e.points && e.points[0]; if (!p) return;
        R.centerX = p.x; R.centerY = p.y;
        var idx = R.activeEntities().indexOf(e); R.selected = idx;
        R.render(); showSel(); drawOverlayUI();
      };
      row.appendChild(cp); row.appendChild(nm); frag.appendChild(row);
    });
    if (arr.length > 600) {
      var more = document.createElement('div'); more.className = 'row txtrow';
      more.innerHTML = '<span class="nm" style="color:#888">…余 ' + (arr.length - 600) + ' 条未列出</span>';
      frag.appendChild(more);
    }
    elTexts.appendChild(frag);
  }

  // ---------------------------------------------------------------- 布局标签
  function buildTabs() {
    elTabs.innerHTML = '';
    if (!S.doc) return;
    R.spaceNames.forEach(function (nm) {
      var b = document.createElement('div');
      b.className = 'tab' + (nm === R.currentSpace ? ' active' : '');
      var cnt = (R.spaces[nm] && R.spaces[nm].entities.length) || 0;
      b.textContent = nm + (cnt ? ' (' + cnt + ')' : '');
      b.title = nm === '模型' ? '模型空间 (MODEL)' : '布局 / 图纸空间 (' + nm + ')';
      b.onclick = function () {
        R.setSpace(nm);
        buildTabs(); buildLayers(); buildTexts(); showSel();
        say('切换到 ' + nm + '，共 ' + cnt + ' 个实体。');
      };
      elTabs.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- 选择属性面板
  function showSel() {
    var idx = R.selected;
    if (idx < 0 || !S.doc) { elSelEmpty.classList.remove('hidden'); elSelActions.classList.add('hidden'); return; }
    var e = R.activeEntities()[idx];
    if (!e) { elSelEmpty.classList.remove('hidden'); elSelActions.classList.add('hidden'); return; }
    elSelEmpty.classList.add('hidden'); elSelActions.classList.remove('hidden');
    elSelLayer.value = e.layer;
    var info = ['类型 ' + e.type, '图层 ' + e.layer];
    if (e._blk) info.push('来自块 ' + e._blk);
    if (e.handle) info.push('句柄 ' + e.handle);
    var loop = entityLoop(e);
    if (loop && loop.length >= 3) info.push('面积 ' + fmt(Math.abs(polyArea(loop))) + '  周长 ' + fmt(polyPerim(loop, true)));
    if (e.type === 'LINE' && e.points && e.points.length > 1) info.push('长度 ' + fmt(Math.hypot(e.points[1].x - e.points[0].x, e.points[1].y - e.points[0].y)));
    if (e.type === 'CIRCLE') info.push('半径 ' + fmt(e.r40) + '  周长 ' + fmt(2 * Math.PI * e.r40));
    if (e.text) info.push('文字 “' + String(e.text).slice(0, 24) + '”');
    var b = e._bb; if (b) info.push('范围 ' + fmt(b.x1 - b.x0) + ' × ' + fmt(b.y1 - b.y0));
    elArea.innerHTML = info.join('<br>');
  }
  elSelLayer.onchange = function () {
    var e = R.activeEntities()[R.selected]; if (!e) return;
    e.layer = elSelLayer.value; e._col = null; R.render(); buildLayers();
    say('实体已移动到图层 ' + e.layer);
  };
  $('btnDel').onclick = function () {
    var idx = R.selected; if (idx < 0) return;
    var sp = R.active(); var e = sp.entities[idx];
    sp.entities.splice(idx, 1); R.selected = -1;
    var ai = S.added.indexOf(e); if (ai >= 0) S.added.splice(ai, 1);
    R.render(); showSel(); buildLayers(); buildTexts();
    say('已删除 1 个 ' + e.type);
  };
  $('btnMove').onclick = function () {
    var e = R.activeEntities()[R.selected]; if (!e) return;
    var s = window.prompt('输入位移 dx,dy：', '0,0'); if (!s) return;
    var m = s.split(/[, ]+/).map(Number);
    if (m.length < 2 || !isFinite(m[0]) || !isFinite(m[1])) { say('位移格式应为 dx,dy'); return; }
    applyMat(e, { a: 1, b: 0, c: 0, d: 1, e: m[0], f: m[1] });
    if (e.type === 'TEXT' || e.type === 'MTEXT') e.r50 = 180 - (e.r50 || 0);  // applyMat 会翻转，撤回
    e._bb = R.bboxOf(e); R.render(); showSel();
    say('已移动 (' + m[0] + ', ' + m[1] + ')');
  };
  // ---------------------------------------------------------------- 工具栏
  function setMode(m) {
    S.mode = m; S.pts = [];
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar button[data-mode]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === m);
    });
    var tips = {
      'select': '选择：点击实体', 'draw-line': '直线：指定第一点', 'draw-circle': '圆：指定圆心',
      'draw-text': '文字：指定插入点', 'm-dist': '距离：指定第一点',
      'm-area': '周长面积：拾第一点（双击闭合）'
    };
    hint(tips[m] || '');
    drawOverlayUI();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#toolbar button[data-mode]'), function (b) {
    b.onclick = function () { setMode(b.getAttribute('data-mode')); };
  });

  // ---------------------------------------------------------------- 侧栏开关
  // 把原来的 4 个静态 <h3> 搬进工具栏做开关按钮：图层 / 分组 / 文字栏 / 属性
  // 默认 #side 隐藏（index.html 已加 class="hidden"），点击才在左侧显示对应栏。
  var elSide = $('side');
  var PANEL_OF = { layers: 'layers', groups: 'groups', texts: 'texts', props: 'selPanel' };
  var S_panel = '';   // 当前激活的面板键；空字符串 = 无
  function setPanel(p) {
    // 再次点击同一面板 →收起侧栏
    if (S_panel === p) p = '';
    S_panel = p;
    var tgt = p ? PANEL_OF[p] : '';
    // 内容区互斥
    Object.keys(PANEL_OF).forEach(function (k) {
      var el = $(PANEL_OF[k]);
      if (el) el.classList.toggle('hidden', PANEL_OF[k] !== tgt);
    });
    // 侧栏整体显示/隐藏
    elSide.classList.toggle('hidden', !tgt);
    // 工具栏按钮 .active 高亮
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar button[data-panel]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-panel') === p);
    });
    // 侧栏尺寸变化后通知渲染器重新计算
    if (R && typeof R.resize === 'function') R.resize();
    if (R && typeof R.render === 'function') R.render();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#toolbar button[data-panel]'), function (b) {
    b.onclick = function () { setPanel(b.getAttribute('data-panel')); };
  });

  $('btnFit').onclick = function () {
    R.zoomExtents();
    say('ZOOM EXTENTS：比例 ' + R.scale.toExponential(3));
    drawOverlayUI();
  };
  $('btnFit').oncontextmenu = function (ev) { ev.preventDefault(); R.zoomDense(); say('ZOOM 密集区'); };
  $('btnSnap').onclick = function () {
    S.snapOn = !S.snapOn; this.classList.toggle('active', S.snapOn);
    R.snap.on = S.snapOn; if (!S.snapOn) R.snapPoint = null;
    say('对象捕捉 ' + (S.snapOn ? '开' : '关'));
    drawOverlayUI();
  };
  $('btnOrtho').onclick = function () {
    S.ortho = !S.ortho; this.classList.toggle('active', S.ortho);
    say('正交 ' + (S.ortho ? '开' : '关')); drawOverlayUI();
  };
  $('btnClearOverlay').onclick = function () {
    R.overlays = []; S.pts = []; R.render(); drawOverlayUI(); say('已清除所有标注。');
  };
  $('btnSave').onclick = function () {
    if (!S.doc) { say('无图形可保存。'); return; }
    try {
      var txt = DxfWriter.writeFlat
        ? DxfWriter.writeFlat(S.doc, R.activeEntities())
        : DxfWriter.write(S.doc, R.activeEntities());
      var name = S.fileName || 'drawing.dxf';
      var blob = new Blob([txt], { type: 'application/dxf' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;                       // 用原文件名写出，用户可覆盖原文件（“写入该文件”）
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      say('已保存 ' + name + '（' + R.activeEntities().length + ' 个实体，含本次编辑）');
    } catch (err) { say('保存失败：' + err.message); }
  };

  // ---------------------------------------------------------------- 键盘（AutoCAD 习惯）
  window.addEventListener('keydown', function (ev) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((ev.target.tagName || '').toUpperCase())) return;
    var k = ev.key;
    if (k === 'F3') { ev.preventDefault(); $('btnSnap').click(); return; }
    if (k === 'F8') { ev.preventDefault(); $('btnOrtho').click(); return; }
    if (k === 'Escape') { S.pts = []; R.selected = -1; setMode('select'); R.render(); showSel(); drawOverlayUI(); say('*取消*'); return; }
    if (k === 'Enter' || k === ' ') {
      if (S.mode === 'm-area' && S.pts.length >= 3) { ev.preventDefault(); finishAreaPoly(); return; }
      if (S.pts.length) { ev.preventDefault(); S.pts = []; drawOverlayUI(); hint(''); return; }
    }
    if (k === 'Delete' && R.selected >= 0) { ev.preventDefault(); $('btnDel').click(); return; }
    if (ev.ctrlKey && (k === 'a' || k === 'A')) return;
    // Z/X 缩放，方向键平移（无鼠标时可用）
    if (k === '+' || k === '=') { R.zoom(1.15); drawOverlayUI(); }
    if (k === '-' || k === '_') { R.zoom(1 / 1.15); drawOverlayUI(); }
    if (k === 'ArrowLeft') { R.pan(-60, 0); drawOverlayUI(); }
    if (k === 'ArrowRight') { R.pan(60, 0); drawOverlayUI(); }
    if (k === 'ArrowUp') { R.pan(0, -60); drawOverlayUI(); }
    if (k === 'ArrowDown') { R.pan(0, 60); drawOverlayUI(); }
  });

  // ---------------------------------------------------------------- 打开文件
  $('fileInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    S.fileName = f.name;
    say('读取 ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + 'MB) …');
    var fr = new FileReader();
    fr.onload = function () {
      setTimeout(function () { loadBuffer(fr.result, f.name); }, 10);
    };
    fr.onerror = function () { say('文件读取失败。'); };
    fr.readAsArrayBuffer(f);          // 必须按字节读，交给解析器判编码
  });

  // ---------------------------------------------------------------- 字体预加载（仅旧 SHX 矢量字形模式）
  // 仅当 useSystemFontForShx=false 时才需要：异步 fetch SHX 字形，加载完成后重渲染换成真矢量字形。
  // 默认系统字体映射模式下系统字体直接渲染，无需预加载。
  function preloadFonts(doc) {
    if (typeof ShxText === 'undefined' || !doc) return Promise.resolve();
    var keys = {};
    function add(k) {
      k = ShxText.normKey(k); if (!k) return;
      var rs = ShxText.resolveStyle(k, '');
      if (rs && rs.system) return;          // TrueType / 系统字体不需要 .shx
      keys[k] = 1;
    }
    add('txt'); add('simplex'); add('gbcbig'); add('hztxt'); add('chineset'); // FONTALT/标准 SHX 兜底（与快速看图一致）
    var st = doc.styles || {};
    Object.keys(st).forEach(function (n) {
      var s = st[n] || {};
      if (s.font) { add(s.font); var sk = ShxText.substitute(ShxText.normKey(s.font)); if (sk) add(sk); }
      if (s.bigFont) { add(s.bigFont); var bk = ShxText.substitute(ShxText.normKey(s.bigFont)); if (bk) add(bk); }
    });
    return ShxText.preload(Object.keys(keys));
  }

  function loadBuffer(buf, name) {
    var t0 = performance.now();
    var d, doc;
    try {
      d = DxfParser.decode(buf);
      doc = DxfParser.parse(d.text);
      doc.encoding = d.encoding;
    } catch (err) {
      say('解析失败：' + err.message); console.error(err); return;
    }
    var t1 = performance.now();
    S.doc = doc;
    // 仅当保留旧 SHX 矢量字形模式（useSystemFontForShx=false）时才异步预加载 SHX 字体；
    // 默认系统字体映射模式下系统字体无需预加载，跳过以避免无谓的网络/CPU 开销与多余重渲染。
    if (typeof ShxText !== 'undefined' && !R.useSystemFontForShx) {
      preloadFonts(doc)
        .then(function () { if (S.doc === doc) R.render(); })
        .catch(function () {});
    }
    S.curLayer = doc.clayer && doc.layers[doc.clayer] ? doc.clayer : '0';
    elCur.textContent = S.curLayer;
    R.showLineweight = !!doc.lwdisplay;
    R.overlays = []; S.added = []; S.pts = [];
    try { R.load(doc); } catch (err2) { say('展开失败：' + err2.message); console.error(err2); return; }
    var t2 = performance.now();
    resize();
    R.fit();
    buildTabs(); buildLayers(); buildTexts(); showSel(); drawOverlayUI();
    var sp = R.active();
    say(name + ' | ' + doc.acadver + ' | ' + d.encoding + ' | 图层 ' + Object.keys(doc.layers).length +
      ' | 实体 ' + sp.entities.length + ' | 解析 ' + (t1 - t0).toFixed(0) + 'ms 展开 ' + (t2 - t1).toFixed(0) + 'ms' +
      ' | 视图 ' + (R.viewMode === 'saved' ? '恢复AutoCAD保存视图' : R.viewMode === 'dense' ? '密集区' : '全范围'));
    hint('滚轮缩放 · 中/右键拖动平移 · 中键双击 ZOOM ALL · F3 捕捉 · F8 正交 · Esc 取消');
  }

  // ---------------------------------------------------------------- 初始化
  R.onView = function () { /* 渲染完成回调：这里刷新 overlay，使十字光标不被覆盖 */ };
  setMode('select');
  $('btnSnap').classList.add('active');
  resize();
  say('就绪。请打开一个 DXF 文件（支持 AC1009–AC1032 / UTF-8 与 GBK 自动识别）。');

  // 拖拽打开
  ['dragover', 'drop'].forEach(function (t) {
    stage.addEventListener(t, function (ev) { ev.preventDefault(); ev.stopPropagation(); });
  });
  stage.addEventListener('drop', function (ev) {
    var f = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f || !/\.dxf$/i.test(f.name)) { say('请拖入 .dxf 文件。'); return; }
    S.fileName = f.name;
    var fr = new FileReader();
    fr.onload = function () { loadBuffer(fr.result, f.name); };
    fr.readAsArrayBuffer(f);
  });

  window.__app = S; window.__R = R;   // 便于自动化测试注入

  // ============================================================
  // 思源插件桥接（dock 预览 / 右键嵌入 / postMessage 协议）
  //   - 启动带 ?asset=<url> 时自动 fetch 加载（dock 初次、embed 都用此方式）
  //   - 监听父窗口下发的 {type:'dxf-load', asset} 切换文件
  //   - 就绪后回报 {type:'dxf-ready'} 给插件
  // ============================================================
  function __loadAssetUrl(url) {
    say('通过网络加载 ' + url + ' …');
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var nm = (url.split('?')[0].split('/').pop()) || 'file.dxf';
      loadBuffer(buf, nm);
    }).catch(function (e) { say('加载失败：' + e.message); });
  }
  var __q = new URLSearchParams(location.search);
  if (__q.get('asset')) {
    __loadAssetUrl(__q.get('asset'));
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'dxf-load' && m.asset) __loadAssetUrl(m.asset);
  });
  try { parent.postMessage({ type: 'dxf-ready' }, '*'); } catch (e) {}
})();
