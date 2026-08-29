/*
 * dxf-writer.js — 把解析后的 doc 序列化回 ASCII DXF（浏览器/Node 通用，零依赖）
 * 策略：优先回显各实体的 _raw（解析时保留的原始 group），保证往返无损；
 *        新增实体由 build* 构造器生成 group。支持坐标变换 transformGroups（移动/镜像）。
 */
(function (global) {
  'use strict';

  function g(code, value) { return { code: code, value: (value === undefined || value === null) ? '' : String(value) }; }

  function groupsToString(groups) {
    var out = '';
    for (var i = 0; i < groups.length; i++) out += groups[i].code + '\n' + groups[i].value + '\n';
    return out;
  }

  // 在 group 序列首部确保有 0 TYPE
  function ensureType(groups, type) {
    if (!groups.length || groups[0].code !== 0) return [g(0, type)].concat(groups);
    return groups;
  }

  function buildLine(p1, p2, layer, color) {
    var gs = [g(0, 'LINE'), g(8, layer || '0')];
    if (color != null) gs.push(g(62, color));
    gs.push(g(10, p1.x), g(20, p1.y), g(30, 0), g(11, p2.x), g(21, p2.y), g(31, 0));
    return gs;
  }
  function buildCircle(c, r, layer, color) {
    var gs = [g(0, 'CIRCLE'), g(8, layer || '0')];
    if (color != null) gs.push(g(62, color));
    gs.push(g(10, c.x), g(20, c.y), g(30, 0), g(40, r));
    return gs;
  }
  function buildArc(c, r, a0, a1, layer, color) {
    var gs = [g(0, 'ARC'), g(8, layer || '0')];
    if (color != null) gs.push(g(62, color));
    gs.push(g(10, c.x), g(20, c.y), g(30, 0), g(40, r), g(50, a0), g(51, a1));
    return gs;
  }
  function buildText(p, text, h, layer, color) {
    var gs = [g(0, 'TEXT'), g(8, layer || '0')];
    if (color != null) gs.push(g(62, color));
    gs.push(g(10, p.x), g(20, p.y), g(30, 0), g(40, h || 2.5), g(1, text || ''), g(7, 'STANDARD'));
    return gs;
  }
  function buildLwpolyline(pts, closed, layer, color) {
    var gs = [g(0, 'LWPOLYLINE'), g(8, layer || '0')];
    if (color != null) gs.push(g(62, color));
    gs.push(g(70, closed ? 1 : 0), g(90, pts.length));
    for (var i = 0; i < pts.length; i++) {
      gs.push(g(10, pts[i].x), g(20, pts[i].y));
      if (pts[i].bulge) gs.push(g(42, pts[i].bulge));
    }
    return gs;
  }

  // 坐标变换：对点（10/20 为 X/Y，30 为 Z 保持不变）应用 fn(x,y) -> [x',y']；返回新 group 数组
  function transformGroups(groups, fn) {
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      var grp = groups[i];
      var c = grp.code;
      // X 族 10-14：与紧随的 20-24（Y）、30-34（Z）配对
      if (c >= 10 && c <= 14) {
        var ygrp = (i + 1 < groups.length && groups[i + 1].code === c + 10) ? groups[i + 1] : null;
        var zgrp = (i + 2 < groups.length && groups[i + 2].code === c + 20) ? groups[i + 2] : null;
        var x = parseFloat(grp.value), y = ygrp ? parseFloat(ygrp.value) : 0;
        var r = fn(x, y);
        out.push(g(c, r[0]));
        if (ygrp) { out.push(g(c + 10, r[1])); i++; if (zgrp) { out.push(g(c + 20, zgrp.value)); i++; } }
        continue;
      }
      if (c >= 20 && c <= 24) continue;          // Y 已随 X 处理
      if (c >= 30 && c <= 39) { out.push(g(c, grp.value)); continue; } // Z 保持不变
      out.push(g(c, grp.value));
    }
    return out;
  }

  function minimalHeader(doc) {
    var units = doc && doc.units != null ? doc.units : 4;
    return [
      g(9, '$ACADVER'), g(1, 'AC1015'),
      g(9, '$INSUNITS'), g(70, units),
      g(9, '$EXTMIN'), g(10, 0), g(20, 0), g(30, 0),
      g(9, '$EXTMAX'), g(10, 100), g(20, 100), g(30, 0)
    ];
  }
  function minimalTables(doc) {
    var names = (doc && doc.layers) ? Object.keys(doc.layers) : ['0'];
    if (names.indexOf('0') < 0) names.unshift('0');
    var t = [g(0, 'TABLE'), g(2, 'LAYER'), g(70, names.length)];
    for (var i = 0; i < names.length; i++) {
      var lay = (doc && doc.layers) ? doc.layers[names[i]] : null;
      var col = (lay && lay.color != null) ? lay.color : 7;
      t.push(g(0, 'LAYER'), g(2, names[i]), g(70, 0), g(62, col), g(6, 'CONTINUOUS'));
    }
    t.push(g(0, 'ENDTAB'));
    return [g(0, 'TABLE'), g(2, 'VPORT'), g(70, 1), g(0, 'VPORT'), g(2, '*ACTIVE'), g(70, 0), g(10, 0), g(20, 0), g(30, 0), g(40, 1), g(41, 1), g(68, 1), g(69, 1), g(0, 'ENDTAB')].concat(t);
  }

  // 从已变换的实体字段重建 DXF group（用于保存扁平几何）
  function entToGroups(ent) {
    var gs = []; var e = ent;
    if (e._raw && (e.type === 'DIMENSION' || e.type === 'ATTRIB')) return e._raw; // 复杂类型回退 _raw
    gs.push(g(0, e.type), g(8, e.layer || '0'));
    if (e.color != null) gs.push(g(62, e.color));
    switch (e.type) {
      case 'LINE':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        if (e.points[1]) gs.push(g(11, e.points[1].x), g(21, e.points[1].y), g(31, 0));
        break;
      case 'LWPOLYLINE':
        gs.push(g(70, e.f70 || 0), g(90, (e.points || []).length));
        (e.points || []).forEach(function (p) { gs.push(g(10, p.x), g(20, p.y)); if (p.bulge) gs.push(g(42, p.bulge)); });
        break;
      case 'CIRCLE':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        gs.push(g(40, e.r40 || 0));
        break;
      case 'ARC':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        gs.push(g(40, e.r40 || 0), g(50, e.a50 || 0), g(51, e.a51 || 0));
        break;
      case 'ELLIPSE':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        if (e.points[1]) gs.push(g(11, e.points[1].x), g(21, e.points[1].y), g(31, 0));
        gs.push(g(40, e.r40 || 1)); gs.push(g(41, e.a50 || 0), g(42, e.a51 || 0));
        break;
      case 'TEXT':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        gs.push(g(40, e.r40 || 2.5), g(1, e.text || ''), g(7, e.style || 'STANDARD'));
        if (e.a50) gs.push(g(50, e.a50));
        break;
      case 'MTEXT':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        gs.push(g(40, e.r40 || 2.5), g(1, e.text || ''), g(7, e.style || 'STANDARD'));
        if (e.a50) gs.push(g(50, e.a50));
        break;
      case 'POINT':
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        break;
      case 'SOLID':
        (e.points || []).forEach(function (p) { gs.push(g(10, p.x), g(20, p.y), g(30, 0)); });
        break;
      case 'INSERT':
        gs.push(g(2, e.name || ''));
        if (e.points[0]) gs.push(g(10, e.points[0].x), g(20, e.points[0].y), g(30, 0));
        gs.push(g(41, e.r41 != null ? e.r41 : 1), g(42, e.r42 != null ? e.r42 : 1), g(43, e.r43 != null ? e.r43 : 1));
        if (e.a50) gs.push(g(50, e.a50));
        break;
      case 'HATCH':
        gs.push(g(10, 0), g(20, 0), g(30, 0), g(210, 0), g(220, 0), g(230, 1));
        gs.push(g(2, e.pattern || 'SOLID'), g(70, e.solid ? 1 : 0), g(71, 0));
        gs.push(g(91, (e.boundaryLoops || []).length));
        (e.boundaryLoops || []).forEach(function (lp) {
          gs.push(g(92, lp.polyline ? (1 | 2) : 1));
          if (lp.polyline) {
            gs.push(g(73, lp.vertices && lp.vertices[0] && lp.vertices[0].bulge ? 1 : 0), g(93, (lp.vertices || []).length));
            (lp.vertices || []).forEach(function (v) { gs.push(g(10, v.x), g(20, v.y)); if (v.bulge) gs.push(g(42, v.bulge)); });
            gs.push(g(97, 0));
          }
        });
        gs.push(g(75, e.hatchStyle || 1), g(76, e.patternType || 1), g(52, e.patternAngle || 45), g(41, e.patternScale || 5));
        gs.push(g(77, 0), g(78, 0));
        gs.push(g(98, (e.seedPoints || []).length));
        (e.seedPoints || []).forEach(function (p) { gs.push(g(10, p.x), g(20, p.y)); });
        break;
      default:
        return e._raw || [];
    }
    return gs;
  }

  function write(doc) {
    if (!doc) return '';
    var s = '';
    s += '0\nSECTION\n2\nHEADER\n';
    s += groupsToString(doc._raw && doc._raw.header && doc._raw.header.length ? doc._raw.header : minimalHeader(doc));
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nTABLES\n';
    s += groupsToString(doc._raw && doc._raw.tables && doc._raw.tables.length ? doc._raw.tables : minimalTables(doc));
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nBLOCKS\n';
    s += groupsToString(doc._raw && doc._raw.blocks && doc._raw.blocks.length ? doc._raw.blocks : []);
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nENTITIES\n';
    for (var e = 0; e < doc.entities.length; e++) {
      var ent = doc.entities[e];
      var gs = ent._raw ? ent._raw : (ent._groups ? ent._groups : []);
      if (!gs || !gs.length) continue;
      s += groupsToString(gs);
    }
    s += '0\nENDSEC\n';
    s += '0\nEOF\n';
    return s;
  }

  // 保存“已展开的扁平几何”（编辑后的当前空间实体）
  function writeFlat(entities, doc) {
    var s = '';
    s += '0\nSECTION\n2\nHEADER\n';
    s += groupsToString(doc && doc._raw && doc._raw.header && doc._raw.header.length ? doc._raw.header : minimalHeader(doc));
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nTABLES\n';
    s += groupsToString(doc && doc._raw && doc._raw.tables && doc._raw.tables.length ? doc._raw.tables : minimalTables(doc));
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nBLOCKS\n';
    s += groupsToString(doc && doc._raw && doc._raw.blocks && doc._raw.blocks.length ? doc._raw.blocks : []);
    s += '0\nENDSEC\n';
    s += '0\nSECTION\n2\nENTITIES\n';
    for (var i = 0; i < entities.length; i++) {
      var gs = entToGroups(entities[i]);
      if (gs && gs.length) s += groupsToString(gs);
    }
    s += '0\nENDSEC\n';
    s += '0\nEOF\n';
    return s;
  }

  var api = {
    write: write, writeFlat: writeFlat, entToGroups: entToGroups,
    buildLine: buildLine, buildCircle: buildCircle, buildArc: buildArc,
    buildText: buildText, buildLwpolyline: buildLwpolyline, transformGroups: transformGroups,
    g: g, groupsToString: groupsToString
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DxfWriter = api;
})(typeof window !== 'undefined' ? window : this);
