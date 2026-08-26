/*
 * dxf-parser.js — ASCII DXF 解析器（浏览器 / Node 通用，零依赖）
 * 目标：与 AutoCAD 2018-2025（AC1032）显示口径一致。
 *
 * 支持段：HEADER / TABLES(LAYER, LTYPE, STYLE, BLOCK_RECORD, DIMSTYLE) / BLOCKS / ENTITIES / OBJECTS(LAYOUT)
 * 实体：LINE LWPOLYLINE POLYLINE(+VERTEX) CIRCLE ARC ELLIPSE SPLINE TEXT MTEXT ATTRIB ATTDEF
 *       INSERT(含阵列/镜像/嵌套) POINT SOLID TRACE 3DFACE HATCH DIMENSION LEADER
 * 颜色：ACI 1-255 + 真彩色(420)；7 号色在深色背景按 AutoCAD 习惯显示为白色。
 * 图层：70 位标志(冻结/锁定) + 62 负值=关闭（AutoCAD 用负色号存 OFF 状态）
 * 线型：LTYPE 表的 49 组虚线段长，供渲染器做 setLineDash。
 * flatten()：用 2x3 仿射矩阵递归展开 INSERT / DIMENSION 块，正确处理镜像(负比例)。
 */
(function (global) {
  'use strict';

  // 二进制 DXF 支持：优先 require 同目录模块（Node），否则取浏览器全局（需在 index.html 先于本文件加载 dxf-binary.js）
  var DxfBinary = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { DxfBinary = require('./dxf-binary'); } catch (e) { DxfBinary = null; }
  } else if (global && global.DxfBinary) {
    DxfBinary = global.DxfBinary;
  }

  // === 完整 AutoCAD ACI 颜色索引 1-255 ===
  var ACI = {
    1:'#FF0000',2:'#FFFF00',3:'#00FF00',4:'#00FFFF',5:'#0000FF',6:'#FF00FF',7:'#FFFFFF',
    8:'#414141',9:'#808080',
    10:'#FF0000',11:'#FFAAAA',12:'#BD0000',13:'#BD7E7E',14:'#810000',15:'#815656',16:'#680000',17:'#684545',18:'#4F0000',19:'#4F3535',
    20:'#FF3F00',21:'#FFBFAA',22:'#BD2E00',23:'#BD8D7E',24:'#811F00',25:'#816056',26:'#681900',27:'#684E45',28:'#4F1300',29:'#4F3B35',
    30:'#FF7F00',31:'#FFD4AA',32:'#BD5E00',33:'#BD9D7E',34:'#814000',35:'#816B56',36:'#683400',37:'#685645',38:'#4F2700',39:'#4F4235',
    40:'#FFBF00',41:'#FFEAAA',42:'#BD8D00',43:'#BDAD7E',44:'#816000',45:'#817656',46:'#684E00',47:'#685F45',48:'#4F3B00',49:'#4F4935',
    50:'#FFFF00',51:'#FFFFAA',52:'#BDBD00',53:'#BDBD7E',54:'#818100',55:'#818156',56:'#686800',57:'#686845',58:'#4F4F00',59:'#4F4F35',
    60:'#BFFF00',61:'#EAFFAA',62:'#8DBD00',63:'#ADBD7E',64:'#608100',65:'#768156',66:'#4E6800',67:'#5F6845',68:'#3B4F00',69:'#494F35',
    70:'#7FFF00',71:'#D4FFAA',72:'#5EBD00',73:'#9DBD7E',74:'#408100',75:'#6B8156',76:'#346800',77:'#566845',78:'#274F00',79:'#424F35',
    80:'#3FFF00',81:'#BFFFAA',82:'#2EBD00',83:'#8DBD7E',84:'#1F8100',85:'#608156',86:'#196800',87:'#4E6845',88:'#134F00',89:'#3B4F35',
    90:'#00FF00',91:'#AAFFAA',92:'#00BD00',93:'#7EBD7E',94:'#008100',95:'#568156',96:'#006800',97:'#456845',98:'#004F00',99:'#354F35',
    100:'#00FF3F',101:'#AAFFBF',102:'#00BD2E',103:'#7EBD8D',104:'#00811F',105:'#568160',106:'#006819',107:'#45684E',108:'#004F13',109:'#354F3B',
    110:'#00FF7F',111:'#AAFFD4',112:'#00BD5E',113:'#7EBD9D',114:'#008140',115:'#56816B',116:'#006834',117:'#456856',118:'#004F27',119:'#354F42',
    120:'#00FFBF',121:'#AAFFEA',122:'#00BD8D',123:'#7EBDAD',124:'#008160',125:'#568176',126:'#00684E',127:'#45685F',128:'#004F3B',129:'#354F49',
    130:'#00FFFF',131:'#AAFFFF',132:'#00BDBD',133:'#7EBDBD',134:'#008181',135:'#568181',136:'#006868',137:'#456868',138:'#004F4F',139:'#354F4F',
    140:'#00BFFF',141:'#AAEAFF',142:'#008DBD',143:'#7EADBD',144:'#006081',145:'#567681',146:'#004E68',147:'#455F68',148:'#003B4F',149:'#35494F',
    150:'#007FFF',151:'#AAD4FF',152:'#005EBD',153:'#7E9DBD',154:'#004081',155:'#566B81',156:'#003468',157:'#455668',158:'#00274F',159:'#35424F',
    160:'#003FFF',161:'#AABFFF',162:'#002EBD',163:'#7E8DBD',164:'#001F81',165:'#566081',166:'#001968',167:'#454E68',168:'#00134F',169:'#353B4F',
    170:'#0000FF',171:'#AAAAFF',172:'#0000BD',173:'#7E7EBD',174:'#000081',175:'#565681',176:'#000068',177:'#454568',178:'#00004F',179:'#35354F',
    180:'#3F00FF',181:'#BFAAFF',182:'#2E00BD',183:'#8D7EBD',184:'#1F0081',185:'#605681',186:'#190068',187:'#4E4568',188:'#13004F',189:'#3B354F',
    190:'#7F00FF',191:'#D4AAFF',192:'#5E00BD',193:'#9D7EBD',194:'#400081',195:'#6B5681',196:'#340068',197:'#564568',198:'#27004F',199:'#42354F',
    200:'#BF00FF',201:'#EAAAFF',202:'#8D00BD',203:'#AD7EBD',204:'#600081',205:'#765681',206:'#4E0068',207:'#5F4568',208:'#3B004F',209:'#49354F',
    210:'#FF00FF',211:'#FFAAFF',212:'#BD00BD',213:'#BD7EBD',214:'#810081',215:'#815681',216:'#680068',217:'#684568',218:'#4F004F',219:'#4F354F',
    220:'#FF00BF',221:'#FFAAEA',222:'#BD008D',223:'#BD7EAD',224:'#810060',225:'#815676',226:'#68004E',227:'#68455F',228:'#4F003B',229:'#4F3549',
    230:'#FF007F',231:'#FFAAD4',232:'#BD005E',233:'#BD7E9D',234:'#810040',235:'#81566B',236:'#680034',237:'#684556',238:'#4F0027',239:'#4F3542',
    240:'#FF003F',241:'#FFAABF',242:'#BD002E',243:'#BD7E8D',244:'#81001F',245:'#815560',246:'#680019',247:'#68454E',248:'#4F0013',249:'#4F353B',
    250:'#333333',251:'#505050',252:'#696969',253:'#828282',254:'#BEBEBE',255:'#FFFFFF'
  };

  // AutoCAD 模型空间默认黑底：7 号色（白/黑自适应）显示为白色。
  // 0 = ByBlock，256 = ByLayer，负值 = 图层关闭（在图层表里才有意义）。
  function aciColor(idx) {
    if (idx == null) return null;
    idx = Math.abs(idx);
    if (idx === 0 || idx === 256) return null;   // 交给上层按 ByBlock/ByLayer 解析
    if (idx === 7) return '#FFFFFF';
    return ACI[idx] || '#FFFFFF';
  }
  function trueColor(v) {
    if (v == null) return null;
    var n = (typeof v === 'number') ? v : parseInt(v, 10);
    if (isNaN(n)) return null;
    var r = (n >> 16) & 255, g2 = (n >> 8) & 255, b = n & 255;
    return 'rgb(' + r + ',' + g2 + ',' + b + ')';
  }

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function int(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  function tokenize(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var groups = [];
    for (var i = 0; i + 1 < lines.length; i += 2) {
      var code = parseInt(lines[i], 10);
      if (isNaN(code)) continue;
      groups.push({ code: code, value: lines[i + 1] });
    }
    return groups;
  }

  function splitSections(groups) {
    var sections = {};
    var cur = null;
    for (var k = 0; k < groups.length; k++) {
      var g = groups[k];
      if (g.code === 0 && g.value === 'SECTION') cur = { name: null, groups: [] };
      else if (g.code === 0 && g.value === 'ENDSEC') { if (cur && cur.name) sections[cur.name] = cur.groups; cur = null; }
      else if (g.code === 2 && cur && cur.name === null) cur.name = g.value;
      else if (cur) cur.groups.push(g);
    }
    return sections;
  }
  function findSection(sections, name) { return sections[name] || []; }

  // ---------------------------------------------------------------------------
  // 实体公共属性
  // ---------------------------------------------------------------------------
  function common(ent, g) {
    switch (g.code) {
      case 8: ent.layer = g.value; return true;
      case 6: ent.linetype = g.value; return true;
      case 48: ent.ltScale = num(g.value); return true;
      case 62: ent.color = int(g.value); return true;
      case 420: ent.trueColor = int(g.value); return true;
      case 370: ent.lineweight = int(g.value); return true;
      case 60: ent.invisible = int(g.value); return true;
      case 5: ent.handle = g.value; return true;
      case 360: ent.xdict = g.value; return true;   // 扩展字典（含 AcDbSpatialFilter 等）
      case 67: ent.paperSpace = int(g.value); return true;
      case 38: ent.elevation = num(g.value); return true;
      case 210: ent.extX = num(g.value); return true;
      case 220: ent.extY = num(g.value); return true;
      case 230: ent.extZ = num(g.value); return true;
    }
    return false;
  }
  function pt(ent, i) { if (!ent.points[i]) ent.points[i] = { x: 0, y: 0, z: 0 }; return ent.points[i]; }
  // 通用 10-14 / 20-24 / 30-34 -> points[0..4]
  function genericPoint(ent, g) {
    var c = g.code;
    if (c >= 10 && c <= 14) { pt(ent, c - 10).x = num(g.value); return true; }
    if (c >= 20 && c <= 24) { pt(ent, c - 20).y = num(g.value); return true; }
    if (c >= 30 && c <= 34) { pt(ent, c - 30).z = num(g.value); return true; }
    return false;
  }

  // 各实体专用读取器：返回 true 表示该 group 已消费
  var READERS = {
    LWPOLYLINE: function (e, g) {
      if (!e.vertices) e.vertices = [];
      switch (g.code) {
        case 90: e.n90 = int(g.value); return true;
        case 70: e.f70 = int(g.value); return true;
        case 43: e.constWidth = num(g.value); return true;
        case 10: e.vertices.push({ x: num(g.value), y: 0, z: 0, bulge: 0 }); return true;
        case 20: if (e.vertices.length) e.vertices[e.vertices.length - 1].y = num(g.value); return true;
        case 42: if (e.vertices.length) e.vertices[e.vertices.length - 1].bulge = num(g.value); return true;
        case 40: case 41: return true;   // 起止宽度，显示忽略（AutoCAD 默认 LWDISPLAY 关）
      }
      return false;
    },
    SPLINE: function (e, g) {
      if (!e.ctrl) { e.ctrl = []; e.fit = []; e.knots = []; e.weights = []; }
      switch (g.code) {
        case 70: e.f70 = int(g.value); return true;
        case 71: e.degree = int(g.value); return true;
        case 72: e.nKnots = int(g.value); return true;
        case 73: e.nCtrl = int(g.value); return true;
        case 74: e.nFit = int(g.value); return true;
        case 40: e.knots.push(num(g.value)); return true;
        case 41: e.weights.push(num(g.value)); return true;
        case 10: e.ctrl.push({ x: num(g.value), y: 0, z: 0 }); return true;
        case 20: if (e.ctrl.length) e.ctrl[e.ctrl.length - 1].y = num(g.value); return true;
        case 30: if (e.ctrl.length) e.ctrl[e.ctrl.length - 1].z = num(g.value); return true;
        case 11: e.fit.push({ x: num(g.value), y: 0, z: 0 }); return true;
        case 21: if (e.fit.length) e.fit[e.fit.length - 1].y = num(g.value); return true;
        case 31: if (e.fit.length) e.fit[e.fit.length - 1].z = num(g.value); return true;
        case 42: case 43: case 44: return true;  // 容差
      }
      return false;
    },
    LEADER: function (e, g) {
      if (!e.vertices) e.vertices = [];
      switch (g.code) {
        case 76: e.nVerts = int(g.value); return true;
        case 10: e.vertices.push({ x: num(g.value), y: 0, z: 0 }); return true;
        case 20: if (e.vertices.length) e.vertices[e.vertices.length - 1].y = num(g.value); return true;
        case 30: if (e.vertices.length) e.vertices[e.vertices.length - 1].z = num(g.value); return true;
        case 3: e.dimStyle = g.value; return true;
      }
      return false;
    },
    ELLIPSE: function (e, g) {
      switch (g.code) {
        case 40: e.ratio = num(g.value); return true;      // 短/长轴比
        case 41: e.startParam = num(g.value); return true;
        case 42: e.endParam = num(g.value); return true;
      }
      return false;
    },
    MTEXT: function (e, g) {
      switch (g.code) {
        case 1: e.text = (e.text || '') + g.value; return true;   // 3 分块在前，1 收尾 —— 必须追加不能覆盖
        case 3: e.text = (e.text || '') + g.value; return true;
        case 7: e.style = g.value; return true;
        case 40: e.r40 = num(g.value); return true;               // 字高
        case 41: e.refWidth = num(g.value); return true;
        case 44: e.lineSpacing = num(g.value); return true;
        case 46: e.defHeight = num(g.value); return true;
        case 71: e.attach = int(g.value); return true;            // 附着点 1-9
        case 72: e.drawDir = int(g.value); return true;
        case 50: e.a50 = num(g.value); return true;
      }
      return false;
    },
    DIMENSION: function (e, g) {
      switch (g.code) {
        case 2: e.name = g.value; return true;    // 绘制该标注的匿名块 *D..
        case 3: e.dimStyle = g.value; return true;
        case 1: e.text = g.value; return true;
        case 70: e.f70 = int(g.value); return true;
      }
      return false;
    },
    INSERT: function (e, g) {
      switch (g.code) {
        case 2: e.name = g.value; return true;
        case 41: e.sx = num(g.value); return true;
        case 42: e.sy = num(g.value); return true;
        case 43: e.sz = num(g.value); return true;
        case 50: e.a50 = num(g.value); return true;
        case 70: e.cols = int(g.value); return true;
        case 71: e.rows = int(g.value); return true;
        case 44: e.colSpace = num(g.value); return true;
        case 45: e.rowSpace = num(g.value); return true;
        case 66: e.attribsFollow = int(g.value); return true;
      }
      return false;
    }
  };
  READERS.ATTRIB = READERS.ATTDEF = null;   // 走通用 TEXT 逻辑

  // TEXT / ATTRIB / ATTDEF 共用
  function textReader(e, g) {
    switch (g.code) {
      case 1: e.text = g.value; return true;
      case 2: e.tag = g.value; return true;
      case 7: e.style = g.value; return true;
      case 40: e.r40 = num(g.value); return true;
      case 41: e.widthFactor = num(g.value); return true;
      case 50: e.a50 = num(g.value); return true;
      case 51: e.oblique = num(g.value); return true;
      case 71: e.genFlags = int(g.value); return true;
      case 72: e.hAlign = int(g.value); return true;
      case 73: e.vAlign = int(g.value); return true;
      case 74: e.vAlign = int(g.value); return true;   // ATTRIB/ATTDEF 的垂直对齐是 74
    }
    return false;
  }

  // 读取一个实体（groups[start] 是 0/TYPE）。返回 {entity, next}
  function readEntity(groups, start, keepRaw) {
    var type = groups[start].value;
    var ent = { type: type, layer: '0', color: null, points: [] };
    var j = start + 1;
    var special = READERS[type];
    if (type === 'TEXT' || type === 'ATTRIB' || type === 'ATTDEF') special = textReader;
    var polyVerts = null;

    while (j < groups.length) {
      var g = groups[j];
      if (g.code === 0) {
        if (type === 'POLYLINE') {
          if (g.value === 'VERTEX') {
            if (!polyVerts) polyVerts = [];
            var vx = 0, vy = 0, vz = 0, vb = 0, vf = 0;
            j++;
            while (j < groups.length && groups[j].code !== 0) {
              var vg = groups[j];
              if (vg.code === 10) vx = num(vg.value);
              else if (vg.code === 20) vy = num(vg.value);
              else if (vg.code === 30) vz = num(vg.value);
              else if (vg.code === 42) vb = num(vg.value);
              else if (vg.code === 70) vf = int(vg.value);
              j++;
            }
            // 70&16 = 多边形网格顶点，不参与 2D 折线；其余顶点收入
            if (!(vf & 16)) polyVerts.push({ x: vx, y: vy, z: vz, bulge: vb });
            continue;
          }
          if (g.value === 'SEQEND') { j++; break; }
        }
        break;
      }
      var consumed = false;
      if (special) consumed = special(ent, g);
      if (!consumed) consumed = common(ent, g);
      if (!consumed) {
        // POLYLINE 的 70/71/72 等
        if (type === 'POLYLINE') {
          if (g.code === 70) { ent.f70 = int(g.value); consumed = true; }
          else if (g.code === 75) { ent.smoothType = int(g.value); consumed = true; }
        }
        if (!consumed) consumed = genericPoint(ent, g);
      }
      if (!consumed) {
        switch (g.code) {
          case 2: if (ent.name == null) ent.name = g.value; break;
          case 1: if (ent.text == null) ent.text = g.value; break;
          case 40: ent.r40 = num(g.value); break;
          case 41: ent.r41 = num(g.value); break;
          case 42: ent.r42 = num(g.value); break;
          case 43: ent.r43 = num(g.value); break;
          case 50: ent.a50 = num(g.value); break;
          case 51: ent.a51 = num(g.value); break;
          case 70: ent.f70 = int(g.value); break;
          case 71: ent.f71 = int(g.value); break;
          case 72: ent.f72 = int(g.value); break;
          case 73: ent.f73 = int(g.value); break;
          case 90: ent.n90 = int(g.value); break;
        }
      }
      j++;
    }
    if (polyVerts) ent.vertices = polyVerts;
    if (keepRaw) ent._raw = groups.slice(start, j);
    return { entity: ent, next: j };
  }

  // ---------------------------------------------------------------------------
  // HATCH：单独解析（边界环 + 图案），避免 10/20 被当成普通点
  // ---------------------------------------------------------------------------
  function readHatch(groups, start, keepRaw) {
    var ent = { type: 'HATCH', layer: '0', color: null, points: [], boundaryLoops: [] };
    var j = start + 1;
    var loop = null, curEdge = null, edgeType = 0, expectEdges = 0, seenEdges = 0;
    var seedPoints = [], inSeed = false, inPattern = false;
    // 图案定义线（组码 78 之后）：每条线 53=角度 43/44=基点 45/46=偏移 79=虚线段数 49=段长
    var inPatDef = false, patLine = null;

    function newEdge(t) {
      curEdge = { kind: (t === 1 ? 'line' : t === 2 ? 'arc' : t === 3 ? 'ellipse' : 'spline') };
      if (curEdge.kind === 'spline') { curEdge.ctrl = []; }
      if (loop) loop.edges.push(curEdge);
    }

    while (j < groups.length) {
      var g = groups[j];
      if (g.code === 0) break;
      switch (g.code) {
        case 8: ent.layer = g.value; break;
        case 62: ent.color = int(g.value); break;
        case 420: ent.trueColor = int(g.value); break;
        case 2: ent.pattern = g.value; break;
        case 70: ent.solid = int(g.value) === 1; break;
        case 71: ent.associative = int(g.value); break;
        case 91: ent.loopCount = int(g.value); break;
        case 92:
          var lt = int(g.value);
          loop = { type: lt, polyline: (lt & 2) !== 0, edges: [], vertices: [] };
          ent.boundaryLoops.push(loop);
          curEdge = null; expectEdges = 0; seenEdges = 0;
          break;
        case 72:
          if (loop && loop.polyline) loop.hasBulge = int(g.value);
          else if (loop) { edgeType = int(g.value); newEdge(edgeType); seenEdges++; }
          break;
        case 73:
          if (loop && loop.polyline) loop.closed = int(g.value);
          else if (curEdge && curEdge.kind === 'arc') curEdge.ccw = int(g.value);
          else if (curEdge && curEdge.kind === 'spline') curEdge.periodic = int(g.value);
          break;
        case 93:
          if (loop && loop.polyline) loop.nVerts = int(g.value);
          else if (loop) { expectEdges = int(g.value); }   // 边数
          break;
        case 94: if (curEdge && curEdge.kind === 'spline') curEdge.degree = int(g.value); break;
        case 95: if (curEdge && curEdge.kind === 'spline') curEdge.nKnots = int(g.value); break;
        case 96: if (curEdge && curEdge.kind === 'spline') curEdge.nCtrl = int(g.value); break;
        case 10:
          if (loop && loop.polyline) loop._cx = num(g.value);
          else if (curEdge) {
            if (curEdge.kind === 'line') curEdge.x1 = num(g.value);
            else if (curEdge.kind === 'spline') curEdge.ctrl.push({ x: num(g.value), y: 0 });
            else curEdge.cx = num(g.value);
          } else if (inSeed) seedPoints.push({ x: num(g.value), y: 0 });
          break;
        case 20:
          if (loop && loop.polyline) loop.vertices.push({ x: loop._cx, y: num(g.value), z: 0, bulge: 0 });
          else if (curEdge) {
            if (curEdge.kind === 'line') curEdge.y1 = num(g.value);
            else if (curEdge.kind === 'spline') { if (curEdge.ctrl.length) curEdge.ctrl[curEdge.ctrl.length - 1].y = num(g.value); }
            else curEdge.cy = num(g.value);
          } else if (inSeed && seedPoints.length) seedPoints[seedPoints.length - 1].y = num(g.value);
          break;
        case 11:
          if (curEdge && curEdge.kind === 'line') curEdge.x2 = num(g.value);
          else if (curEdge && curEdge.kind === 'ellipse') curEdge.mx = num(g.value);
          break;
        case 21:
          if (curEdge && curEdge.kind === 'line') curEdge.y2 = num(g.value);
          else if (curEdge && curEdge.kind === 'ellipse') curEdge.my = num(g.value);
          break;
        case 40:
          if (curEdge && curEdge.kind === 'arc') curEdge.r = num(g.value);
          else if (curEdge && curEdge.kind === 'ellipse') curEdge.ratio = num(g.value);
          else if (curEdge && curEdge.kind === 'spline') { if (!curEdge.knots) curEdge.knots = []; curEdge.knots.push(num(g.value)); }
          break;
        case 50: if (curEdge && (curEdge.kind === 'arc' || curEdge.kind === 'ellipse')) curEdge.a1 = num(g.value); break;
        case 51: if (curEdge && (curEdge.kind === 'arc' || curEdge.kind === 'ellipse')) curEdge.a2 = num(g.value); break;
        case 42: if (loop && loop.polyline && loop.vertices.length) loop.vertices[loop.vertices.length - 1].bulge = num(g.value); break;
        case 97: curEdge = null; break;      // 源边界对象数 -> 本环边定义结束
        case 75: ent.hatchStyle = int(g.value); break;
        case 76: ent.patternType = int(g.value); break;
        case 52: ent.patternAngle = num(g.value); inPattern = true; break;
        case 41: if (inPattern) ent.patternScale = num(g.value); break;
        case 47: ent.pixelSize = num(g.value); break;
        case 98: inSeed = true; loop = null; curEdge = null; inPatDef = false; break;
        // ---- 图案定义线：使之能像 AutoCAD 一样按真实图案（图形单位）绘制 ----
        case 78:
          inPatDef = true; inPattern = true;
          ent.patLines = []; patLine = null;
          break;
        case 53:
          if (inPatDef) { patLine = { angle: num(g.value), bx: 0, by: 0, ox: 0, oy: 0, dashes: [] }; ent.patLines.push(patLine); }
          break;
        case 43: if (inPatDef && patLine) patLine.bx = num(g.value); break;
        case 44: if (inPatDef && patLine) patLine.by = num(g.value); break;
        case 45: if (inPatDef && patLine) patLine.ox = num(g.value); break;
        case 46: if (inPatDef && patLine) patLine.oy = num(g.value); break;
        case 79: if (inPatDef && patLine) patLine.nDash = int(g.value); break;
        case 49: if (inPatDef && patLine) patLine.dashes.push(num(g.value)); break;
        default: break;
      }
      j++;
    }
    ent.seedPoints = seedPoints;
    if (keepRaw) ent._raw = groups.slice(start, j);
    return { entity: ent, next: j };
  }

  function parseEntities(groups, keepRaw) {
    var out = []; var i = 0;
    while (i < groups.length) {
      if (groups[i].code === 0 && groups[i].value === 'ENDSEC') break;
      if (groups[i].code === 0) {
        var v = groups[i].value;
        if (v === 'ENDBLK' || v === 'BLOCK' || v === 'SEQEND') { i++; continue; }
        var r = (v === 'HATCH') ? readHatch(groups, i, keepRaw) : readEntity(groups, i, keepRaw);
        if (r.entity && r.entity.type) out.push(r.entity);
        i = (r.next > i) ? r.next : i + 1;
      } else i++;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 主解析
  // ---------------------------------------------------------------------------
  function parse(text, opts) {
    opts = opts || {};
    var keepRaw = opts.keepRaw !== false;
    var groups = tokenize(text);
    var sections = splitSections(groups);
    var doc = {
      header: {}, layers: {}, linetypes: {}, styles: {}, dimStyles: {}, vports: {}, blocks: {}, entities: [],
      units: null, ltscale: 1, extmin: null, extmax: null,
      viewctr: null, viewsize: 0, viewaspect: 0, viewFrom: null,
      layouts: {}, blockRecordByHandle: {},
      _raw: {
        header: findSection(sections, 'HEADER'),
        tables: findSection(sections, 'TABLES'),
        blocks: findSection(sections, 'BLOCKS'),
        objects: findSection(sections, 'OBJECTS')
      }
    };

    // ---- HEADER ----
    var h = doc._raw.header;
    for (var hi = 0; hi < h.length; hi++) {
      if (h[hi].code !== 9) continue;
      var vn = h[hi].value;
      if (vn === '$EXTMIN' || vn === '$EXTMAX' || vn === '$LIMMIN' || vn === '$LIMMAX' ||
          vn === '$VIEWCTR' || vn === '$PEXTMIN' || vn === '$PEXTMAX') {
        var p = { x: 0, y: 0, z: 0 };
        for (var q = hi + 1; q < h.length && h[q].code !== 9; q++) {
          if (h[q].code === 10) p.x = num(h[q].value);
          else if (h[q].code === 20) p.y = num(h[q].value);
          else if (h[q].code === 30) p.z = num(h[q].value);
        }
        if (vn === '$EXTMIN') doc.extmin = p;
        else if (vn === '$EXTMAX') doc.extmax = p;
        else if (vn === '$LIMMIN') doc.limmin = p;
        else if (vn === '$LIMMAX') doc.limmax = p;
        else if (vn === '$VIEWCTR') doc.viewctr = p;
        else if (vn === '$PEXTMIN') doc.pextmin = p;
        else if (vn === '$PEXTMAX') doc.pextmax = p;
        continue;
      }
      var vg = h[hi + 1];
      if (!vg) continue;
      doc.header[vn] = vg.value;
      if (vn === '$INSUNITS') doc.units = int(vg.value);
      else if (vn === '$LTSCALE') doc.ltscale = num(vg.value) || 1;
      else if (vn === '$CELTSCALE') doc.celtscale = num(vg.value) || 1;
      else if (vn === '$ACADVER') doc.acadver = vg.value;
      else if (vn === '$DWGCODEPAGE') doc.codepage = String(vg.value || '');
      else if (vn === '$VIEWSIZE') doc.viewsize = num(vg.value) || 0;
      else if (vn === '$TEXTSIZE') doc.textsize = num(vg.value) || 0;
      else if (vn === '$DIMSCALE') doc.dimscale = num(vg.value) || 1;
      else if (vn === '$CLAYER') doc.clayer = String(vg.value || '0');
      else if (vn === '$LWDISPLAY') doc.lwdisplay = int(vg.value) === 1;
      else if (vn === '$TILEMODE') doc.tilemode = int(vg.value);
      else if (vn === '$PSLTSCALE') doc.psltscale = int(vg.value);
      hi++;
    }

    // ---- TABLES ----
    var t = doc._raw.tables;
    var k = 0;
    while (k < t.length) {
      if (t[k].code === 0 && t[k].value === 'TABLE' && t[k + 1] && t[k + 1].code === 2) {
        var tname = t[k + 1].value;
        var m = k; while (m < t.length && !(t[m].code === 0 && t[m].value === 'ENDTAB')) m++;
        var body = t.slice(k + 2, m);

        if (tname === 'LAYER') {
          doc._raw.layerTable = t.slice(k, m + 1);
          eachRecord(body, 'LAYER', function (rec) {
            var name = '0', color = 7, flags = 0, lt = 'Continuous', lw = -1, plot = 1, tc = null;
            rec.forEach(function (gg) {
              if (gg.code === 2) name = gg.value;
              else if (gg.code === 62) color = int(gg.value);
              else if (gg.code === 70) flags = int(gg.value);
              else if (gg.code === 6) lt = gg.value;
              else if (gg.code === 370) lw = int(gg.value);
              else if (gg.code === 290) plot = int(gg.value);
              else if (gg.code === 420) tc = int(gg.value);
            });
            doc.layers[name] = {
              name: name,
              color: Math.abs(color),
              trueColor: tc,
              off: color < 0,                  // AutoCAD 用负色号表示图层关闭
              // 组码 70：位1=冻结；位2=「在新视口中默认冻结」(≠当前视口冻结，不能当冻结)；位4=锁定
              frozen: !!(flags & 1),
              vpFrozenDefault: !!(flags & 2),
              locked: !!(flags & 4),
              linetype: lt, lineweight: lw, plot: plot
            };
          });
        } else if (tname === 'VPORT') {
          // *Active 视口 = AutoCAD 保存的当前视图（HEADER 的 $VIEWCTR/$VIEWSIZE 只是它的影子，
          // 很多导出/转换工具不写 HEADER 那两项，但一定会写 VPORT）
          eachRecord(body, 'VPORT', function (rec) {
            var name = '', ctr = null, hgt = 0, asp = 0, snapAng = 0, tw = 0, th = 0;
            rec.forEach(function (gg) {
              if (gg.code === 2) name = gg.value;
              else if (gg.code === 12) { ctr = ctr || { x: 0, y: 0 }; ctr.x = num(gg.value); }
              else if (gg.code === 22) { ctr = ctr || { x: 0, y: 0 }; ctr.y = num(gg.value); }
              else if (gg.code === 40) hgt = num(gg.value);
              else if (gg.code === 41) asp = num(gg.value);
              else if (gg.code === 51) snapAng = num(gg.value);
              else if (gg.code === 17) tw = num(gg.value);
              else if (gg.code === 27) th = num(gg.value);
            });
            if (name) doc.vports[name] = { name: name, center: ctr, height: hgt, aspect: asp, snapAngle: snapAng };
            if (/^\*active$/i.test(name) && ctr && hgt > 0) {
              // 补齐 HEADER 缺失的保存视图
              if (!doc.viewctr) doc.viewctr = { x: ctr.x, y: ctr.y, z: 0 };
              if (!(doc.viewsize > 0)) doc.viewsize = hgt;
              if (!(doc.viewaspect > 0)) doc.viewaspect = asp;
              doc.viewFrom = 'VPORT';
            }
          });
        } else if (tname === 'LTYPE') {
          eachRecord(body, 'LTYPE', function (rec) {
            var name = '', desc = '', total = 0, dashes = [], nd = 0;
            rec.forEach(function (gg) {
              if (gg.code === 2) name = gg.value;
              else if (gg.code === 3) desc = gg.value;
              else if (gg.code === 73) nd = int(gg.value);
              else if (gg.code === 40) total = num(gg.value);
              else if (gg.code === 49) dashes.push(num(gg.value));
            });
            if (name) doc.linetypes[name] = { name: name, desc: desc, total: total, dashes: dashes, count: nd };
          });
        } else if (tname === 'STYLE') {
          eachRecord(body, 'STYLE', function (rec) {
            var name = 'Standard', font = '', big = '', height = 0, xs = 1, obl = 0, flags = 0;
            rec.forEach(function (gg) {
              if (gg.code === 2) name = gg.value;
              else if (gg.code === 3) font = gg.value;
              else if (gg.code === 4) big = gg.value;
              else if (gg.code === 40) height = num(gg.value);
              else if (gg.code === 41) xs = num(gg.value) || 1;
              else if (gg.code === 50) obl = num(gg.value);
              else if (gg.code === 71) flags = int(gg.value);
            });
            doc.styles[name] = { name: name, font: font, bigFont: big, height: height, xscale: xs, oblique: obl, genFlags: flags };
          });
        } else if (tname === 'DIMSTYLE') {
          eachRecord(body, 'DIMSTYLE', function (rec) {
            var name = '', scale = 1, txtH = 2.5;
            rec.forEach(function (gg) {
              if (gg.code === 2) name = gg.value;
              else if (gg.code === 40) scale = num(gg.value) || 1;
              else if (gg.code === 140) txtH = num(gg.value) || 2.5;
            });
            if (name) doc.dimStyles[name] = { name: name, scale: scale, textHeight: txtH };
          });
        } else if (tname === 'BLOCK_RECORD') {
          eachRecord(body, 'BLOCK_RECORD', function (rec) {
            var bh = null, bn = null;
            rec.forEach(function (gg) { if (gg.code === 5 && !bh) bh = gg.value; else if (gg.code === 2) bn = gg.value; });
            if (bh && bn) doc.blockRecordByHandle[bh] = bn;
          });
        }
        k = m + 1;
      } else k++;
    }

    function eachRecord(body, type, cb) {
      var i = 0;
      while (i < body.length) {
        if (body[i].code === 0 && body[i].value === type) {
          var j2 = i + 1; while (j2 < body.length && body[j2].code !== 0) j2++;
          cb(body.slice(i, j2));
          i = j2;
        } else i++;
      }
    }

    // ---- BLOCKS ----
    var b = doc._raw.blocks;
    var bi = 0;
    while (bi < b.length) {
      if (b[bi].code === 0 && b[bi].value === 'BLOCK') {
        // 块头
        var blkName = null, baseX = 0, baseY = 0, baseZ = 0, blkFlags = 0, xrefPath = null;
        var p2 = bi + 1;
        while (p2 < b.length && b[p2].code !== 0) {
          var bg = b[p2];
          if (bg.code === 2 && blkName === null) blkName = bg.value;
          else if (bg.code === 10) baseX = num(bg.value);
          else if (bg.code === 20) baseY = num(bg.value);
          else if (bg.code === 30) baseZ = num(bg.value);
          else if (bg.code === 70) blkFlags = int(bg.value);
          else if (bg.code === 1) xrefPath = bg.value;
          p2++;
        }
        // 块体：从块头结束到 ENDBLK
        var bodyStart = p2, e2 = p2;
        while (e2 < b.length && !(b[e2].code === 0 && b[e2].value === 'ENDBLK')) e2++;
        var blkEnts = parseEntities(b.slice(bodyStart, e2), keepRaw);
        if (blkName) {
          doc.blocks[blkName] = {
            name: blkName,
            base: { x: baseX, y: baseY, z: baseZ },
            entities: blkEnts,
            flags: blkFlags,
            xrefPath: xrefPath,
            isXref: !!(blkFlags & 124) || !!xrefPath   // 4|8|16|32|64 = xref/overlay/dependent/resolved/referenced; group 1 path also indicates xref
          };
        }
        bi = e2 + 1;
      } else bi++;
    }

    // ---- ENTITIES ----
    doc.entities = parseEntities(findSection(sections, 'ENTITIES'), keepRaw);

    // ---- OBJECTS: LAYOUT ----
    var objs = doc._raw.objects;
    var oi = 0;
    while (oi < objs.length) {
      if (objs[oi].code === 0 && objs[oi].value === 'LAYOUT') {
        var oj = oi + 1; while (oj < objs.length && objs[oj].code !== 0) oj++;
        var subclass = '', lname = null, lbh = null, lorder = 0;
        var limMin = null, limMax = null, papMin = null, papMax = null, nViews = 0;
        for (var z = oi; z < oj; z++) {
          var gg2 = objs[z];
          if (gg2.code === 100) subclass = gg2.value;
          else if (gg2.code === 1 && subclass === 'AcDbLayout') lname = gg2.value;
          else if (gg2.code === 340) lbh = gg2.value;
          else if (gg2.code === 330 && subclass === 'AcDbLayout' && !lbh) lbh = gg2.value;
          else if (gg2.code === 71 && subclass === 'AcDbLayout') lorder = int(gg2.value);
          else if (gg2.code === 76 && subclass === 'AcDbLayout') nViews = int(gg2.value);
          // 11/21/31 最小界限, 12/22/32 最大界限（图纸空间单位）
          else if (gg2.code === 11) { limMin = limMin || { x: 0, y: 0 }; limMin.x = num(gg2.value); }
          else if (gg2.code === 21) { limMin = limMin || { x: 0, y: 0 }; limMin.y = num(gg2.value); }
          else if (gg2.code === 12) { limMax = limMax || { x: 0, y: 0 }; limMax.x = num(gg2.value); }
          else if (gg2.code === 22) { limMax = limMax || { x: 0, y: 0 }; limMax.y = num(gg2.value); }
          // 14/24/34 打印范围最小, 15/25/35 打印范围最大（纸张实际可打印区）
          else if (gg2.code === 14) { papMin = papMin || { x: 0, y: 0 }; papMin.x = num(gg2.value); }
          else if (gg2.code === 24) { papMin = papMin || { x: 0, y: 0 }; papMin.y = num(gg2.value); }
          else if (gg2.code === 15) { papMax = papMax || { x: 0, y: 0 }; papMax.x = num(gg2.value); }
          else if (gg2.code === 25) { papMax = papMax || { x: 0, y: 0 }; papMax.y = num(gg2.value); }
        }
        if (lname && lname !== 'Model') {
          var bn2 = lbh ? doc.blockRecordByHandle[lbh] : null;
          doc.layouts[lname] = {
            name: lname, blockRecordHandle: lbh, blockName: bn2, tabOrder: lorder,
            nViews: nViews, limMin: limMin, limMax: limMax, paperMin: papMin, paperMax: papMax
          };
        }
        oi = oj;
      } else oi++;
    }

    extractSpatialFilters(doc);
    return doc;
  }

  // ---------------------------------------------------------------------------
  // 提取 AcDbSpatialFilter（块参照的空间裁剪 / XCLIP）：
  // INSERT(360=xdict) → DICTIONARY(ACAD_FILTER, 360=child) → DICTIONARY(SPATIAL, 360=filter)
  //   → AcDbSpatialFilter(边界点 = 块局部坐标)。沿 owner(330) 链回溯到 INSERT，
  // 把裁剪矩形（块局部）挂在 doc.spatialFilters[insertHandle]，并回写到 INSERT 实体。
  // ---------------------------------------------------------------------------
  function extractSpatialFilters(doc) {
    doc.spatialFilters = {};
    var objs = doc._raw.objects;
    if (!objs || !objs.length) return;
    var byH = {};
    var i = 0, N = objs.length;
    while (i < N) {
      if (objs[i].code === 0) {
        var o = { h: null, owner: null, type0: objs[i].value, pts: [], subs: [], dicts: {}, m40: [] };
        var j = i + 1, seen210 = false, _px = null;
        while (j < N && objs[j].code !== 0) {
          var g = objs[j];
          if (g.code === 5) o.h = g.value;
          else if (g.code === 330) o.owner = g.value;
          else if (g.code === 100) o.subs.push(g.value);
          else if (g.code === 3) {
            var k = j + 1;
            if (k < N && objs[k].code === 360) { o.dicts[g.value] = objs[k].value; j = k; }
          }
          else if (g.code === 40) o.m40.push(num(g.value));
          else if (!seen210 && g.code === 10) _px = num(g.value);
          else if (!seen210 && g.code === 20 && _px != null) { o.pts.push({ x: _px, y: num(g.value) }); _px = null; }
          else if (g.code === 210) { seen210 = true; _px = null; }
          j++;
        }
        if (o.h) byH[o.h] = o;
        i = j;
      } else i++;
    }
    // 识别空间过滤器对象 → 回溯 owner 链到 INSERT
    // 注意：INSERT 实体在 doc.entities / 块定义里，不在 doc._raw.objects，
    // 因此 owner 链终点（INSERT 句柄）需用 insertByHandle 单独查找。
    var insertByHandle = {};
    function indexInserts(list) {
      if (!list) return;
      for (var k = 0; k < list.length; k++) {
        var e = list[k];
        if (!e) continue;
        if (e.type === 'INSERT' && e.handle) insertByHandle[e.handle] = true;
        if (e.entities) indexInserts(e.entities);
      }
    }
    indexInserts(doc.entities);
    for (var bn in doc.blocks) if (doc.blocks[bn].entities) indexInserts(doc.blocks[bn].entities);

    for (var h in byH) {
      var f = byH[h];
      var isF = (f.subs.indexOf('AcDbSpatialFilter') >= 0) || (f.type0 === 'SPATIAL_FILTER') || (f.type0 === 'AcDbSpatialFilter');
      if (!isF || f.pts.length < 2) continue;
      var cur = f.owner, insH = null, depth = 0;
      while (cur && depth < 8) {
        if (insertByHandle[cur]) { insH = cur; break; }
        var po = byH[cur];
        if (!po) break;
        cur = po.owner; depth++;
      }
      if (!insH) continue;
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (var p = 0; p < f.pts.length; p++) {
        var q = f.pts[p];
        if (q.x < minx) minx = q.x; if (q.x > maxx) maxx = q.x;
        if (q.y < miny) miny = q.y; if (q.y > maxy) maxy = q.y;
      }
      // SPATIAL_FILTER 变换矩阵（group 40，前 12 个值，3×4 仿射）：
      //   行0 = [a c e]，行1 = [b d f]，行2 = [0 0 1]
      // 把裁剪边界（filter-ECS 坐标）映射到块坐标系，再经 INSERT_M 变换到世界坐标。
      var mtx = null;
      if (f.m40 && f.m40.length >= 12) {
        var mv = f.m40.slice(0, 12);
        mtx = { a: mv[0], b: mv[4], c: mv[1], d: mv[5], e: mv[3], f: mv[7] };
      }
      doc.spatialFilters[insH] = { minx: minx, miny: miny, maxx: maxx, maxy: maxy, mtx: mtx };
    }
    // 回写到 INSERT 实体（顶层与嵌套都处理）
    function attach(list) {
      if (!list) return;
      for (var k = 0; k < list.length; k++) {
        var e = list[k];
        if (!e) continue;
        if (e.type === 'INSERT' && e.handle && doc.spatialFilters[e.handle]) e.spatialFilter = doc.spatialFilters[e.handle];
        if (e.entities) attach(e.entities);
      }
    }
    attach(doc.entities);
    for (var bn in doc.blocks) if (doc.blocks[bn].entities) attach(doc.blocks[bn].entities);
  }

  // ---------------------------------------------------------------------------
  // 2x3 仿射矩阵：[a c e ; b d f]，与 canvas setTransform 同序
  // ---------------------------------------------------------------------------
  function matIdent() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  function matMul(m, n) {   // 先 n 再 m —— 即 m∘n
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  }
  function matApply(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, z: 0 }; }
  function matDet(m) { return m.a * m.d - m.b * m.c; }
  // 平均缩放（用于半径/字高）
  function matScale(m) {
    var s1 = Math.hypot(m.a, m.b), s2 = Math.hypot(m.c, m.d);
    return (s1 + s2) / 2 || 1;
  }
  function matRot(m) { return Math.atan2(m.b, m.a); }

  // ---- OCS（对象坐标系 / 拉伸向量 N=(210,220,230)）转 WCS ----
  // 实体可定义在平面法向 N 指定的任意 OCS 上，其坐标需先用「任意轴算法」转回 WCS，
  // 再叠加块矩阵。忽略 OCS 会使线/椭圆/弧错位（"线条排列混乱、排列错位"的常见根因）。
  function ocsBasis(N) {
    var L = Math.hypot(N.x, N.y, N.z) || 1;
    N = { x: N.x / L, y: N.y / L, z: N.z / L };
    var Ax;
    if (Math.abs(N.x) < 1 / 64 && Math.abs(N.y) < 1 / 64) Ax = { x: N.z, y: 0, z: -N.x };  // 参考轴 (0,1,0) × N
    else Ax = { x: -N.y, y: N.x, z: 0 };                                                  // 参考轴 (0,0,1) × N
    var aL = Math.hypot(Ax.x, Ax.y, Ax.z) || 1; Ax = { x: Ax.x / aL, y: Ax.y / aL, z: Ax.z / aL };
    var Ay = { x: N.y * Ax.z - N.z * Ax.y, y: N.z * Ax.x - N.x * Ax.z, z: N.x * Ax.y - N.y * Ax.x };
    var aLy = Math.hypot(Ay.x, Ay.y, Ay.z) || 1; Ay = { x: Ay.x / aLy, y: Ay.y / aLy, z: Ay.z / aLy };
    return { N: N, Ax: Ax, Ay: Ay };
  }
  function ocsPt(x, y, z, b) {
    return {
      x: x * b.Ax.x + y * b.Ay.x + z * b.N.x,
      y: x * b.Ax.y + y * b.Ay.y + z * b.N.y,
      z: x * b.Ax.z + y * b.Ay.z + z * b.N.z
    };
  }
  function ocToWcs(e, N) {
    var b = ocsBasis(N);
    var elev = (e.elevation != null) ? e.elevation : 0;
    var axAng = Math.atan2(b.Ax.y, b.Ax.x) * 180 / Math.PI;   // OCS x 轴在 WCS 下的朝向
    var mirror = (b.N.z < 0);
    function mapP(p) { if (!p) return; var w = ocsPt(p.x, p.y, (p.z != null ? p.z : elev), b); p.x = w.x; p.y = w.y; }
    if (e.points) e.points.forEach(mapP);
    if (e.vertices) e.vertices.forEach(mapP);
    if (e.ctrl) e.ctrl.forEach(mapP);
    if (e.fit) e.fit.forEach(mapP);
    if (e.boundaryLoops) e.boundaryLoops.forEach(function (lp) {
      if (lp.vertices) lp.vertices.forEach(mapP);
      if (lp.edges) lp.edges.forEach(function (ed) {
        if (!ed) return;
        if (ed.kind === 'line') { var a = ocsPt(ed.x1 || 0, ed.y1 || 0, 0, b); ed.x1 = a.x; ed.y1 = a.y; var c = ocsPt(ed.x2 || 0, ed.y2 || 0, 0, b); ed.x2 = c.x; ed.y2 = c.y; }
        else if (ed.cx != null) { var d = ocsPt(ed.cx || 0, ed.cy || 0, (ed.cz != null ? ed.cz : 0), b); ed.cx = d.x; ed.cy = d.y; if (ed.mx != null) { var m = ocsPt(ed.mx, ed.my || 0, 0, b); ed.mx = m.x; ed.my = m.y; } }
        else if (ed.ctrl) ed.ctrl.forEach(mapP);
      });
    });
    if (e.type === 'ELLIPSE' && e.points[1]) {
      var mvx = e.points[1].x, mvy = e.points[1].y;
      e.points[1].x = mvx * b.Ax.x + mvy * b.Ay.x;
      e.points[1].y = mvx * b.Ax.y + mvy * b.Ay.y;
    }
    if (e.type === 'ARC') {
      if (e.a50 != null) e.a50 += axAng;
      if (e.a51 != null) e.a51 += axAng;
      if (mirror) { var t0 = e.a50, t1 = e.a51; e.a50 = 180 - t1 + axAng; e.a51 = 180 - t0 + axAng; }
    }
    if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') {
      if (e.a50 != null) e.a50 += axAng;
    }
    e.extX = 0; e.extY = 0; e.extZ = 1;   // 标记为单位法向，避免重复转换
  }

  function xformEntity(e, m, doc) {
    var det = matDet(m), sc = matScale(m);
    if (e.points && e.points.length) {
      for (var i = 0; i < e.points.length; i++) {
        // ELLIPSE points[1] 是长轴端点向量（相对中心），不是绝对坐标，
        // 应由下方 ELLIPSE 专用分支用线性部分（无平移）变换；跳过避免误加平移。
        if (e.type === 'ELLIPSE' && i === 1) continue;
        var p = e.points[i]; if (!p) continue;
        var np = matApply(m, p.x, p.y); p.x = np.x; p.y = np.y;
      }
    }
    if (e.vertices) for (var v = 0; v < e.vertices.length; v++) {
      var q = e.vertices[v]; var nq = matApply(m, q.x, q.y); q.x = nq.x; q.y = nq.y;
      if (q.bulge && det < 0) q.bulge = -q.bulge;    // 镜像后凸度反向
    }
    if (e.ctrl) for (var c = 0; c < e.ctrl.length; c++) { var cp = e.ctrl[c]; var ncp = matApply(m, cp.x, cp.y); cp.x = ncp.x; cp.y = ncp.y; }
    if (e.fit) for (var f2 = 0; f2 < e.fit.length; f2++) { var fp = e.fit[f2]; var nfp = matApply(m, fp.x, fp.y); fp.x = nfp.x; fp.y = nfp.y; }
    if (e.boundaryLoops) for (var L = 0; L < e.boundaryLoops.length; L++) {
      var lp = e.boundaryLoops[L];
      if (lp.vertices) for (var w = 0; w < lp.vertices.length; w++) {
        var lv = lp.vertices[w]; var nlv = matApply(m, lv.x, lv.y); lv.x = nlv.x; lv.y = nlv.y;
        if (lv.bulge && det < 0) lv.bulge = -lv.bulge;
      }
      if (lp.edges) for (var E = 0; E < lp.edges.length; E++) {
        var ed = lp.edges[E]; if (!ed) continue;
        if (ed.kind === 'line') {
          var a1 = matApply(m, ed.x1 || 0, ed.y1 || 0), a2 = matApply(m, ed.x2 || 0, ed.y2 || 0);
          ed.x1 = a1.x; ed.y1 = a1.y; ed.x2 = a2.x; ed.y2 = a2.y;
        } else if (ed.kind === 'arc' || ed.kind === 'ellipse') {
          var cc = matApply(m, ed.cx || 0, ed.cy || 0); ed.cx = cc.x; ed.cy = cc.y;
          if (ed.r != null) ed.r *= sc;
          if (ed.mx != null) { var mm = matApply(m, (ed.cx0 != null ? ed.cx0 : 0), 0); }
          var rr = matRot(m) * 180 / Math.PI;
          if (det >= 0) { if (ed.a1 != null) ed.a1 += rr; if (ed.a2 != null) ed.a2 += rr; }
          else { var t1 = ed.a1, t2 = ed.a2; if (t1 != null && t2 != null) { ed.a1 = 180 - t2 + rr; ed.a2 = 180 - t1 + rr; } }
        } else if (ed.kind === 'spline' && ed.ctrl) {
          for (var sc2 = 0; sc2 < ed.ctrl.length; sc2++) { var sp2 = ed.ctrl[sc2]; var nsp = matApply(m, sp2.x, sp2.y); sp2.x = nsp.x; sp2.y = nsp.y; }
        }
      }
    }
    // 半径 / 角度 / 字高
    if (e.type === 'CIRCLE' || e.type === 'ARC') {
      if (e.r40 != null) e.r40 = Math.abs(e.r40 * sc);
      if (e.type === 'ARC') {
        if (det >= 0) {
          var rot = matRot(m) * 180 / Math.PI;
          e.a50 = (e.a50 || 0) + rot; e.a51 = (e.a51 || 0) + rot;
        } else {
          // 镜像：精确变换圆弧端点方向，正确处理 x/y 不同轴镜像。
          // 旧公式 "180 - angle + rot" 只对 y 轴镜像（sx<0）正确，
          // 对 x 轴镜像（sy<0）会画到相反方向。
          var s0 = (e.a50 || 0) * Math.PI / 180;
          var s1 = (e.a51 || 0) * Math.PI / 180;
          var t0 = Math.atan2(m.b * Math.cos(s0) + m.d * Math.sin(s0), m.a * Math.cos(s0) + m.c * Math.sin(s0));
          var t1 = Math.atan2(m.b * Math.cos(s1) + m.d * Math.sin(s1), m.a * Math.cos(s1) + m.c * Math.sin(s1));
          // 镜像改变圆弧方向，交换起止角
          e.a50 = t1 * 180 / Math.PI;
          e.a51 = t0 * 180 / Math.PI;
        }
        while (e.a50 < 0) e.a50 += 360; while (e.a50 >= 360) e.a50 -= 360;
        while (e.a51 < 0) e.a51 += 360; while (e.a51 >= 360) e.a51 -= 360;
      }
    }
    if (e.type === 'ELLIPSE') {
      // points[1] 是长轴端点向量（相对中心），需按线性部分变换（不含平移）
      if (e.points[1]) {
        var lin = { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 };
        var mv = matApply(lin, e._majX != null ? e._majX : e.points[1].x, e._majY != null ? e._majY : e.points[1].y);
        e.points[1].x = mv.x; e.points[1].y = mv.y;
      }
    }
    // HATCH：边界环已随矩阵变换，但图案定义线（角度/基准点/偏移/虚线）也要同步变换，
    // 否则块内填充展开到世界坐标后，裁剪区在块的世界位置、图案线却仍在块局部坐标 → 填充不显示。
    if (e.type === 'HATCH' && e.patLines) {
      var linP = { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 };
      var scP = Math.abs(matScale(m));
      for (var pi = 0; pi < e.patLines.length; pi++) {
        var pl = e.patLines[pi];
        if (pl.angle != null) {                       // 方向：线性部分旋转（含非均匀缩放的剪切）
          var angP = pl.angle * Math.PI / 180;
          var dirP = matApply(linP, Math.cos(angP), Math.sin(angP));
          pl.angle = Math.atan2(dirP.y, dirP.x) * 180 / Math.PI;
        }
        if (pl.bx != null || pl.by != null) {         // 基准点（点）随矩阵含平移
          var bpP = matApply(m, pl.bx || 0, pl.by || 0);
          pl.bx = bpP.x; pl.by = bpP.y;
        }
        if (pl.ox != null || pl.oy != null) {         // 偏移（向量）随线性部分，不含平移
          var ofP = matApply(linP, pl.ox || 0, pl.oy || 0);
          pl.ox = ofP.x; pl.oy = ofP.y;
        }
        if (pl.dashes && pl.dashes.length) {          // 虚线长度随缩放
          for (var di = 0; di < pl.dashes.length; di++) pl.dashes[di] *= scP;
        }
      }
    }
    if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') {
      // group 40 为 0 时解析样式固定高度 / $TEXTSIZE；再随块插入比例缩放
      if (!(e.r40 > 0)) {
        var stName = e.style || 'Standard';
        var st = (doc && (doc.styles[stName] || doc.styles['Standard'] || doc.styles['STANDARD']));
        e.r40 = (st && st.height) || (doc && doc.textsize) || 2.5;
      }
      if (e.r40 != null) e.r40 = Math.abs(e.r40 * sc);
      var rt = matRot(m) * 180 / Math.PI;
      e.a50 = (e.a50 || 0) + rt;
      if (det < 0) e._mirrored = true;    // MIRRTEXT 默认 0：文字不翻转，仅位置镜像
    }
    if (e.type === 'SPLINE' && e.knots) { /* 结点无需变换 */ }
    return e;
  }

  function cloneEntity(ent) {
    var ne = {};
    for (var key in ent) if (ent.hasOwnProperty(key)) ne[key] = ent[key];
    if (ne.points) ne.points = ne.points.map(function (p) { return p ? { x: p.x, y: p.y, z: p.z || 0 } : p; });
    if (ne.vertices) ne.vertices = ne.vertices.map(function (v) { return { x: v.x, y: v.y, z: v.z || 0, bulge: v.bulge || 0 }; });
    if (ne.ctrl) ne.ctrl = ne.ctrl.map(function (p) { return { x: p.x, y: p.y, z: p.z || 0 }; });
    if (ne.fit) ne.fit = ne.fit.map(function (p) { return { x: p.x, y: p.y, z: p.z || 0 }; });
    if (ne.boundaryLoops) ne.boundaryLoops = ne.boundaryLoops.map(function (lp) {
      return {
        type: lp.type, polyline: lp.polyline, closed: lp.closed, nVerts: lp.nVerts,
        vertices: lp.vertices ? lp.vertices.map(function (v) { return { x: v.x, y: v.y, z: 0, bulge: v.bulge || 0 }; }) : null,
        edges: lp.edges ? lp.edges.map(function (ed) { var c = {}; for (var kk in ed) if (ed.hasOwnProperty(kk)) c[kk] = ed[kk]; if (ed.ctrl) c.ctrl = ed.ctrl.map(function (p) { return { x: p.x, y: p.y }; }); return c; }) : null
      };
    });
    // 图案定义线（基准点/偏移/虚线）必须深拷贝：块被多次插入时各克隆应独立，
    // 否则会复用同一 patLine 对象，xformEntity 多次累加变换导致坐标错乱（填充消失/错位）。
    if (ne.patLines) ne.patLines = ne.patLines.map(function (pl) {
      var c = {}; for (var kk in pl) if (pl.hasOwnProperty(kk)) c[kk] = pl[kk];
      if (c.dashes) c.dashes = c.dashes.slice();
      return c;
    });
    if (ne.seedPoints) ne.seedPoints = ne.seedPoints.map(function (p) { return { x: p.x, y: p.y, z: 0 }; });
    return ne;
  }

  var LEAF = {
    LINE: 1, LWPOLYLINE: 1, POLYLINE: 1, CIRCLE: 1, ARC: 1, ELLIPSE: 1, SPLINE: 1,
    TEXT: 1, MTEXT: 1, ATTRIB: 1, POINT: 1, SOLID: 1, TRACE: 1, '3DFACE': 1, HATCH: 1, LEADER: 1
  };

  /**
   * 块参照上下文：用于实现 AutoCAD 的属性继承语义。
   *   layer  —— 块参照的「有效图层」（层 0 的块内实体归到这一层）
   *   aci    —— 块参照解析出的具体 ACI（BYBLOCK 的块内实体用它）
   *   rgb    —— 块参照解析出的真彩色（优先于 aci）
   *   ltype  —— 块参照的有效线型（BYBLOCK 线型用它）
   *   frz    —— 祖先块参照的图层名数组；其中任一层被【冻结】则整块不可见
   *
   * AutoCAD 权威规则（Autodesk 论坛/知识库确认）：
   *   1) 冻结块参照所在层 → 整个块参照全部不可见（无论块内实体在哪层）
   *   2) 关闭块参照所在层 → 只隐藏块内「正好在该层」的实体，其它仍可见
   *   3) 块内层 "0" 的实体 → 视为在块参照所在层
   *   4) 块内颜色 BYBLOCK → 用块参照所在【图层】的颜色；块参照有颜色替代时用替代色
   *   注意 3)+4) 合起来意味着「取色所依据的层」与「控制可见性的层」可以不是同一层，
   *   所以 BYBLOCK 必须在展开时就地解析成具体颜色，不能留给渲染期按自身图层解析。
   */
  function resolveInsertCtx(ent, doc, parent) {
    var layers = doc.layers || {};
    // 有效图层：块参照自己在层 0 时，继续沿用上层块参照的有效图层
    var lay = ent.layer;
    if ((lay == null || lay === '0') && parent && parent.layer) lay = parent.layer;
    if (lay == null) lay = '0';

    var rgb = null, aci = 7;
    if (ent.trueColor != null) {
      rgb = ent.trueColor;
    } else if (ent.color != null && ent.color !== 0 && ent.color !== 256) {
      aci = ent.color;                                  // 块参照自带颜色替代
    } else if (ent.color === 0 && parent) {
      rgb = parent.rgb; aci = parent.aci;               // 块参照本身 BYBLOCK → 继续上溯
    } else {
      var L = layers[lay];                              // BYLAYER（含缺省）→ 取有效层颜色
      if (L) {
        if (L.trueColor != null) rgb = L.trueColor;
        else if (L.color != null) aci = Math.abs(L.color) || 7;   // 层关闭时 DXF 记为负值
      }
    }

    var lt = ent.linetype;
    if (!lt || lt === 'BYLAYER' || lt === 'ByLayer') {
      var L2 = layers[lay]; lt = L2 ? L2.linetype : null;
    } else if (lt === 'BYBLOCK' || lt === 'ByBlock') {
      lt = parent ? parent.ltype : null;
    }

    // 祖先层链：仅用于「冻结」传播。同名不重复，未变化时复用同一数组（省内存）
    var frz = parent ? parent.frz : null;
    if (!frz) frz = [lay];
    else if (frz.indexOf(lay) < 0) frz = frz.concat([lay]);

    return { layer: lay, aci: aci, rgb: rgb, ltype: lt, frz: frz };
  }

  /**
   * 递归展开：INSERT（含阵列、镜像、嵌套）与 DIMENSION（用其匿名块绘制），
   * 输出绝对 WCS 坐标的叶子实体，并就地完成 AutoCAD 的属性继承。
   * opts: { maxDepth, entities }
   */
  function flatten(doc, opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 16;
    var out = [];
    var blocks = doc.blocks || {};

    // 计算实体（已是 WCS 坐标）的世界包围盒，用于空间裁剪判定
    function entityWorldBBox(e) {
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      function add(x, y) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      if (e.points) for (var i = 0; i < e.points.length; i++) {
        // ELLIPSE points[1] / MTEXT points[1] 是相对向量，不是绝对坐标，不加入 bbox。
        if ((e.type === 'ELLIPSE' || e.type === 'MTEXT') && i === 1) continue;
        if (e.points[i]) add(e.points[i].x, e.points[i].y);
      }
      if (e.vertices) for (var v = 0; v < e.vertices.length; v++) add(e.vertices[v].x, e.vertices[v].y);
      if (e.ctrl) for (var c = 0; c < e.ctrl.length; c++) add(e.ctrl[c].x, e.ctrl[c].y);
      if (e.fit) for (var f = 0; f < e.fit.length; f++) add(e.fit[f].x, e.fit[f].y);
      if (e.boundaryLoops) for (var lp = 0; lp < e.boundaryLoops.length; lp++) {
        var L = e.boundaryLoops[lp];
        if (L.vertices) for (var vi = 0; vi < L.vertices.length; vi++) add(L.vertices[vi].x, L.vertices[vi].y);
        if (L.edges) for (var ei = 0; ei < L.edges.length; ei++) {
          var ed = L.edges[ei]; if (!ed) continue;
          if (ed.kind === 'line') { add(ed.x1, ed.y1); add(ed.x2, ed.y2); }
          else if (ed.cx != null) { var r = ed.r || 0; add(ed.cx - r, ed.cy - r); add(ed.cx + r, ed.cy + r); }
          else if (ed.ctrl) for (var ci = 0; ci < ed.ctrl.length; ci++) add(ed.ctrl[ci].x, ed.ctrl[ci].y);
        }
      }
      if (e.type === 'CIRCLE' || e.type === 'ARC') { var cc = e.points && e.points[0]; var cr = e.r40 || 0; if (cc) { add(cc.x - cr, cc.y - cr); add(cc.x + cr, cc.y + cr); } }
      else if (e.type === 'ELLIPSE') { var ec = e.points && e.points[0]; var mv = e.points && e.points[1]; var ratio = e.ratio || 1; if (ec && mv) { var rad = Math.hypot(mv.x, mv.y) * Math.max(1, ratio); add(ec.x - rad, ec.y - rad); add(ec.x + rad, ec.y + rad); } }
      if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') {
        var tp = e.points && e.points[0];
        var th = e.r40 || 0;
        if (!(th > 0)) {
          var stName2 = e.style || 'Standard';
          var st2 = doc && (doc.styles[stName2] || doc.styles['Standard'] || doc.styles['STANDARD']);
          th = (st2 && st2.height) || (doc && doc.textsize) || 2.5;
        }
        if (tp) { add(tp.x - th, tp.y - th); add(tp.x + th, tp.y + th); }
      }
      if (minx === Infinity) { var pp = (e.points && e.points[0]) || (e.vertices && e.vertices[0]); if (pp) { minx = maxx = pp.x; miny = maxy = pp.y; } else return null; }
      return { x0: minx, y0: miny, x1: maxx, y1: maxy };
    }
    function intersectClip(a, b) {
      if (!a) return b; if (!b) return a;
      var rx1 = Math.max(a.minx, b.minx), ry1 = Math.max(a.miny, b.miny);
      var rx2 = Math.min(a.maxx, b.maxx), ry2 = Math.min(a.maxy, b.maxy);
      if (rx1 > rx2 || ry1 > ry2) return null;   // 无交集 → 整支被裁掉
      return { minx: rx1, miny: ry1, maxx: rx2, maxy: ry2 };
    }

    function walk(ent, m, depth, srcBlock, ctx, clip) {
      if (depth > maxDepth) return;
      if (ent.invisible === 1) return;

      if (ent.type === 'INSERT') {
        var blk = blocks[ent.name];
        // 外部参照：块内已含几何（被绑定/内嵌）时 AutoCAD 会显示其内容，应展开；
        // 仅无几何的占位桩才视为未加载参照而隐藏（与 AutoCAD 一致）。
        if (!blk) return;
        if (blk.isXref && (!blk.entities || blk.entities.length === 0)) return;
        var nctx = resolveInsertCtx(ent, doc, ctx);
        var sx = (ent.sx != null && ent.sx !== 0) ? ent.sx : 1;
        var sy = (ent.sy != null && ent.sy !== 0) ? ent.sy : 1;
        var rot = (ent.a50 || 0) * Math.PI / 180;
        var ip = ent.points[0] || { x: 0, y: 0 };
        var cols = Math.max(1, ent.cols || 1), rows = Math.max(1, ent.rows || 1);
        var cs = ent.colSpace || 0, rs = ent.rowSpace || 0;
        var cosR = Math.cos(rot), sinR = Math.sin(rot);
        for (var ci = 0; ci < cols; ci++) {
          for (var ri = 0; ri < rows; ri++) {
            // 阵列偏移在插入的旋转坐标系中
            var ox = ip.x + (cs * ci) * cosR - (rs * ri) * sinR;
            var oy = ip.y + (cs * ci) * sinR + (rs * ri) * cosR;
            // local = T(ox,oy) · R(rot) · S(sx,sy) · T(-base)
            var local = {
              a: cosR * sx, b: sinR * sx,
              c: -sinR * sy, d: cosR * sy,
              e: ox, f: oy
            };
            var base = blk.base || { x: 0, y: 0 };
            var shifted = matMul(local, { a: 1, b: 0, c: 0, d: 1, e: -base.x, f: -base.y });
            var nm = matMul(m, shifted);
            // 空间裁剪（AcDbSpatialFilter / XCLIP）：
            // 先把裁剪边界（filter-ECS）经 FILTER_M 映射到块坐标系，再经 nm（INSERT_M）变换到世界坐标。
            var childClip = clip;
            if (ent.spatialFilter) {
              var sf = ent.spatialFilter, mt = sf.mtx;
              function f2b(x, y) {
                if (mt) return { x: mt.a * x + mt.c * y + mt.e, y: mt.b * x + mt.d * y + mt.f };
                return { x: x, y: y };
              }
              var b1 = f2b(sf.minx, sf.miny), b2 = f2b(sf.maxx, sf.miny);
              var b3 = f2b(sf.minx, sf.maxy), b4 = f2b(sf.maxx, sf.maxy);
              var c1 = matApply(nm, b1.x, b1.y), c2 = matApply(nm, b2.x, b2.y);
              var c3 = matApply(nm, b3.x, b3.y), c4 = matApply(nm, b4.x, b4.y);
              var wc = {
                minx: Math.min(c1.x, c2.x, c3.x, c4.x), miny: Math.min(c1.y, c2.y, c3.y, c4.y),
                maxx: Math.max(c1.x, c2.x, c3.x, c4.x), maxy: Math.max(c1.y, c2.y, c3.y, c4.y)
              };
              childClip = intersectClip(clip, wc);
            }
            for (var bi2 = 0; bi2 < blk.entities.length; bi2++) walk(blk.entities[bi2], nm, depth + 1, ent.name, nctx, childClip);
          }
        }
        return;
      }

      if (ent.type === 'DIMENSION') {
        // AutoCAD 用匿名块 *D.. 绘制标注，块内几何已是 WCS 绝对坐标（不再叠加变换）
        var dblk = ent.name ? blocks[ent.name] : null;
        if (dblk && !dblk.isXref) {
          var dctx = resolveInsertCtx(ent, doc, ctx);
          for (var di = 0; di < dblk.entities.length; di++) walk(dblk.entities[di], m, depth + 1, ent.name, dctx, clip);
        }
        return;   // 没有关联块则不绘制（与 AutoCAD 一致：无块的 DIMENSION 不显示）
      }

      if (LEAF[ent.type]) {
        var ne = cloneEntity(ent);
        // OCS → WCS：实体坐标在任意平面，需先转回 WCS 再叠加块矩阵（解决线条/椭圆错位）
        var ex = ne.extX || 0, ey = ne.extY || 0, ez = (ne.extZ != null ? ne.extZ : 1);
        if (Math.abs(ex) > 1e-6 || Math.abs(ey) > 1e-6 || Math.abs(ez - 1) > 1e-6) {
          var h = Math.hypot(ex, ey, ez);
          if (h > 1e-6) ocToWcs(ne, { x: ex, y: ey, z: ez });
        }
        if (ne.type === 'ELLIPSE' && ne.points[1]) { ne._majX = ne.points[1].x; ne._majY = ne.points[1].y; }
        // 单位矩阵时跳过变换，省时
        if (!(m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0)) xformEntity(ne, m, doc);
        if (srcBlock) ne._blk = srcBlock;

        // 空间裁剪：被裁剪矩形完全排除的实体直接丢弃； surviving 的附加 _clip
        var bb = entityWorldBBox(ne);
        if (bb) ne._bb = bb;                         // HATCH 等需要包围盒做图案填充
        if (clip) {
          if (!bb || bb.x1 < clip.minx || bb.x0 > clip.maxx || bb.y1 < clip.miny || bb.y0 > clip.maxy) return;
          ne._clip = clip;
        }

        if (ctx) {
          // 规则 3：块内层 "0" 归到块参照的有效层
          if (ne.layer == null || ne.layer === '0') ne.layer = ctx.layer;
          // 规则 4：BYBLOCK 颜色就地解析成具体颜色
          if (ne.trueColor == null && ne.color === 0) {
            if (ctx.rgb != null) ne.trueColor = ctx.rgb;
            else ne.color = ctx.aci;
          }
          // BYBLOCK 线型
          if (ne.linetype === 'BYBLOCK' || ne.linetype === 'ByBlock') ne.linetype = ctx.ltype;
          // 规则 1：祖先块参照层被冻结 → 整块不可见（渲染期查这条链）
          if (ctx.frz && (ctx.frz.length > 1 || ctx.frz[0] !== ne.layer)) ne._anc = ctx.frz;
        }
        out.push(ne);
      }
    }

    var ents = opts.entities || doc.entities || [];
    for (var i = 0; i < ents.length; i++) walk(ents[i], matIdent(), 0, null, null);
    return out;
  }

  // ============ 编码解码 ============
  // DXF R2007(AC1021)+ 一律 UTF-8；更早版本用 $DWGCODEPAGE 指定的 ANSI 代码页。
  // 实际工程文件常有混杂/半截情况，故采用「严格 UTF-8 试解码 → 失败回退代码页」策略。
  var CODEPAGE_MAP = {
    ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_932: 'shift_jis', ANSI_949: 'euc-kr',
    ANSI_1252: 'windows-1252', ANSI_1251: 'windows-1251', ANSI_1250: 'windows-1250',
    ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
    ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
    ANSI_874: 'windows-874', ANSI_1361: 'euc-kr', UTF8: 'utf-8', ANSI_437: 'windows-1252'
  };

  function bytesOf(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  // 无需 TextDecoder 的 UTF-8 合法性校验（同时统计中日韩字符数用于置信判断）
  function utf8Check(u8, limit) {
    var n = limit && limit < u8.length ? limit : u8.length;
    var i = 0, multi = 0, high = 0;
    while (i < n) {
      var c = u8[i];
      if (c < 0x80) { i++; continue; }
      high++;
      var need, min;
      if (c >= 0xC2 && c <= 0xDF) { need = 1; min = 0x80; }
      else if (c >= 0xE0 && c <= 0xEF) { need = 2; min = 0x800; }
      else if (c >= 0xF0 && c <= 0xF4) { need = 3; min = 0x10000; }
      else return { ok: false, multi: multi, high: high };
      if (i + need >= n) { if (i + need >= u8.length) return { ok: false, multi: multi, high: high }; break; }
      var cp = c & (need === 1 ? 0x1F : need === 2 ? 0x0F : 0x07);
      for (var k = 1; k <= need; k++) {
        var cc = u8[i + k];
        if (cc < 0x80 || cc > 0xBF) return { ok: false, multi: multi, high: high };
        cp = (cp << 6) | (cc & 0x3F);
      }
      if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return { ok: false, multi: multi, high: high };
      multi++; i += need + 1;
    }
    return { ok: true, multi: multi, high: high };
  }

  function dec(u8, enc) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder(enc).decode(u8); } catch (e) { /* 该编码不被支持 */ }
    }
    if (typeof Buffer !== 'undefined') {
      var bn = enc === 'utf-8' ? 'utf8' : null;
      if (bn) return Buffer.from(u8).toString(bn);
    }
    // 最后兜底：latin1 逐字节
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return s;
  }

  // 把 \U+XXXX 转义（旧版 DXF 存非本地字符时使用）还原成真字符
  function unescapeUniEsc(s) {
    return s.indexOf('\\U+') < 0 ? s : s.replace(/\\U\+([0-9A-Fa-f]{4})/g, function (_, hx) {
      return String.fromCharCode(parseInt(hx, 16));
    });
  }

  /**
   * 把 ArrayBuffer / Uint8Array / Buffer 解码成 DXF 文本。
   * 返回 { text, encoding, acadver, codepage }
   */
  function decode(input) {
    var u8 = bytesOf(input);
    if (u8 == null) {                       // 已经是字符串
      var t0 = String(input);
      return { text: unescapeUniEsc(t0), encoding: 'string', acadver: '', codepage: '' };
    }
    // 二进制 DXF：先转成等价 ASCII DXF 字节流，再走下面的标准解码（编码嗅探/解析 100% 复用 ASCII 路径）
    if (DxfBinary && DxfBinary.isBinaryDxf(u8)) {
      u8 = DxfBinary.binaryToText(u8);
    }
    // 跳过 UTF-8 BOM
    if (u8.length > 2 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
      u8 = u8.subarray(3);
      return { text: unescapeUniEsc(dec(u8, 'utf-8')), encoding: 'utf-8(bom)', acadver: '', codepage: '' };
    }
    // 从头部 ASCII 区嗅探 $ACADVER / $DWGCODEPAGE
    var headTxt = dec(u8.subarray(0, Math.min(u8.length, 8192)), 'utf-8');
    var mv = headTxt.match(/\$ACADVER[\s\S]{0,12}?(AC\d{4})/);
    var mc = headTxt.match(/\$DWGCODEPAGE[\s\S]{0,20}?(ANSI_\d+|UTF8|utf8)/i);
    var acadver = mv ? mv[1] : '';
    var codepage = mc ? mc[1].toUpperCase() : '';
    var verNum = acadver ? parseInt(acadver.slice(2), 10) : 0;

    var chk = utf8Check(u8);
    var enc;
    if (chk.ok && (chk.multi > 0 || chk.high === 0)) {
      enc = 'utf-8';                                   // 合法 UTF-8：直接用（AC1021+ 的常态）
    } else if (verNum >= 1021 && chk.ok) {
      enc = 'utf-8';
    } else {
      enc = CODEPAGE_MAP[codepage] || (verNum >= 1021 ? 'utf-8' : 'gbk');
    }
    var text = dec(u8, enc);
    // 若解出大量替换字符，换用代码页重试一次
    if (enc === 'utf-8' && text.indexOf('\uFFFD') >= 0) {
      var alt = CODEPAGE_MAP[codepage] || 'gbk';
      var t2 = dec(u8, alt);
      if (t2.indexOf('\uFFFD') < 0) { text = t2; enc = alt + '(fallback)'; }
    }
    return { text: unescapeUniEsc(text), encoding: enc, acadver: acadver, codepage: codepage };
  }

  /** 便捷入口：字节 → doc（自动解码） */
  function parseBuffer(input, opts) {
    var d = decode(input);
    var doc = parse(d.text, opts);
    doc.encoding = d.encoding;
    return doc;
  }

  var api = {
    parse: parse, parseBuffer: parseBuffer, decode: decode,
    aciColor: aciColor, trueColor: trueColor, ACI: ACI, flatten: flatten,
    matIdent: matIdent, matMul: matMul, matApply: matApply, cloneEntity: cloneEntity
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DxfParser = api;
})(typeof window !== 'undefined' ? window : this);
