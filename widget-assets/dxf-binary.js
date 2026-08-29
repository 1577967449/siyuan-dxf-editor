/*
 * dxf-binary.js — AutoCAD 二进制 DXF 解码（浏览器 / Node 通用，零依赖）
 * ---------------------------------------------------------------------------
 * 用途：把 AutoCAD「另存为 → 文件类型 → Binary DXF」保存出来的二进制字节流，
 *       转换成与对应 ASCII DXF **完全等价** 的字节流（Uint8Array）。
 *
 * 设计要点（为什么显示会和 ASCII 完全一致）：
 *   - 本模块只做「二进制组码/值对 → 文本 DXF 行」的 1:1 转换，不解析任何语义。
 *   - 字符串字段（TEXT/MTEXT/图层名/块名…）**保留原始字节**直接写入输出字节流，
 *     由 dxf-parser.js 的 decode() 沿用既有编码嗅探（UTF-8 / GBK / ANSI 代码页）
 *     来还原，与打开一份同编码的 ASCII DXF 走完全相同的分支。
 *   - 数值字段按 AutoCAD 二进制规范（组码→数据类型映射）解出真实 double/int 后再
 *     文本化，因此下游 parse / flatten / 渲染 100% 复用 ASCII 路径。
 *   => 同一张图，Binary DXF 与 ASCII DXF 解析出的 doc 逐字段相同，渲染像素一致。
 *
 * 二进制 DXF 格式（R12 及以后通用）：
 *   文件头哨兵（22 字节）： "AutoCAD Binary DXF\r\n" + 0x1A + 0x00
 *   之后是若干「组码 + 值」对，全部 **大端 (big-endian)**：
 *     - 组码：2 字节有符号 short
 *     - 值：依组码范围决定类型（见 typeOf）
 *         · 字符串类：2 字节长度（含结尾 \0）+ 字符字节
 *         · 双精度类：8 字节 IEEE754
 *         · 短整类：2 字节
 *         · 长整类：4 字节
 *         · 布尔类：1 字节（0/1）
 *         · 字节类：1 字节
 *         · 二进制块(310-319)：2 字节长度 + 原始字节（输出为十六进制文本）
 */
(function (global) {
  'use strict';

  // 22 字节哨兵
  var SENTINEL = [
    0x41, 0x75, 0x74, 0x6F, 0x43, 0x41, 0x44, 0x20, 0x42, 0x69,
    0x6E, 0x61, 0x72, 0x79, 0x20, 0x44, 0x58, 0x46, 0x0D, 0x0A, 0x1A, 0x00
  ];

  function toBytes(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return null;
  }

  /** 判断字节流是否以二进制 DXF 哨兵开头 */
  function isBinaryDxf(input) {
    var u8 = toBytes(input);
    if (!u8 || u8.length < SENTINEL.length) return false;
    for (var i = 0; i < SENTINEL.length; i++) {
      if (u8[i] !== SENTINEL[i]) return false;
    }
    return true;
  }

  // ---- 大端读取助手 ----
  function readU16BE(u8, p) { return (u8[p] << 8) | u8[p + 1]; }
  function readI16BE(u8, p) { var v = readU16BE(u8, p); return v >= 0x8000 ? v - 0x10000 : v; }
  function readI32BE(u8, p) {
    var v = (u8[p] * 0x1000000) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }
  function readF64BE(u8, p) {
    if (typeof DataView !== 'undefined') {
      return new DataView(u8.buffer, u8.byteOffset + p, 8).getFloat64(0, false);
    }
    // 极老环境兜底（手动重组 IEEE754 大端）
    var s = (u8[p] & 0x80) ? -1 : 1;
    var e = ((u8[p] & 0x7F) << 4) | ((u8[p + 1] & 0xF0) >> 4);
    var m = 0;
    for (var i = 0; i < 6; i++) m = m * 256 + u8[p + 2 + i];
    m += (u8[p + 1] & 0x0F) * Math.pow(2, 48);
    if (e === 0) return s * Math.pow(2, -1022) * (m / Math.pow(2, 52));
    return s * Math.pow(2, e - 1023) * (1 + m / Math.pow(2, 52));
  }

  /** 读字符串：2 字节长度（含结尾 \0）+ 字符字节；返回 {bytes, next} */
  function readStr(u8, p) {
    var len = readU16BE(u8, p); p += 2;
    var end = p + len;
    if (end > u8.length) end = u8.length;
    // 去掉结尾的 0x00（AutoCAD 字符串以 \0 结束）
    while (end > p && u8[end - 1] === 0) end--;
    return { bytes: u8.subarray(p, end), next: p + len };
  }

  /** 按组码返回值类型 */
  function typeOf(code) {
    if (code >= 0 && code <= 9) return 'string';
    if (code >= 10 && code <= 39) return 'double';
    if (code >= 40 && code <= 59) return 'double';
    if (code >= 60 && code <= 79) return 'i16';
    if (code >= 90 && code <= 99) return 'i32';
    if (code === 100) return 'string';
    if (code === 102) return 'string';
    if (code === 105) return 'string';
    if (code >= 110 && code <= 119) return 'double';
    if (code >= 120 && code <= 129) return 'double';
    if (code >= 130 && code <= 139) return 'double';
    if (code >= 140 && code <= 149) return 'double';
    if (code >= 160 && code <= 169) return 'i32';
    if (code >= 170 && code <= 179) return 'i16';
    if (code >= 210 && code <= 239) return 'double';
    if (code >= 270 && code <= 279) return 'i16';
    if (code >= 280 && code <= 289) return 'i16';
    if (code >= 290 && code <= 299) return 'bool';
    if (code >= 300 && code <= 309) return 'string';
    if (code >= 310 && code <= 319) return 'bin';
    if (code >= 320 && code <= 329) return 'string';
    if (code >= 330 && code <= 369) return 'string';
    if (code >= 370 && code <= 379) return 'byte';
    if (code >= 380 && code <= 389) return 'byte';
    if (code >= 390 && code <= 399) return 'string';
    if (code >= 400 && code <= 409) return 'i16';
    if (code >= 410 && code <= 419) return 'string';
    if (code >= 420 && code <= 429) return 'i32';
    if (code >= 430 && code <= 439) return 'string';
    if (code >= 440 && code <= 449) return 'i32';
    if (code >= 450 && code <= 459) return 'i32';
    if (code >= 460 && code <= 469) return 'double';
    if (code >= 470 && code <= 479) return 'string';
    if (code >= 480 && code <= 481) return 'string';
    if (code === 999) return 'string';
    if (code >= 1000 && code <= 1009) return 'string';
    if (code >= 1010 && code <= 1059) return 'double';
    if (code >= 1060 && code <= 1070) return 'i16';
    if (code === 1071) return 'i32';
    return 'string'; // 未知组码：按字符串兜底，绝不丢数据
  }

  function formatNum(v) {
    if (!isFinite(v)) return String(v);
    // JS 最短往返表示，下游 Number() 解析回完全相同的 double
    return v.toString();
  }

  /**
   * 把二进制 DXF 字节流转换成等价的 ASCII DXF 字节流（Uint8Array）。
   * 非二进制输入原样返回。
   */
  function binaryToText(input) {
    var u8 = toBytes(input);
    if (!u8 || !isBinaryDxf(u8)) return u8;
    var pos = SENTINEL.length;
    var chunks = [];
    function pushAsc(s) { for (var i = 0; i < s.length; i++) chunks.push(s.charCodeAt(i) & 0xFF); }
    function pushBytes(arr) { for (var i = 0; i < arr.length; i++) chunks.push(arr[i]); }

    while (pos + 2 <= u8.length) {
      var code = readU16BE(u8, pos); pos += 2;
      var t = typeOf(code);
      pushAsc(String(code)); chunks.push(13, 10); // 组码行 + \r\n

      if (t === 'double') {
        pushAsc(formatNum(readF64BE(u8, pos))); pos += 8;
      } else if (t === 'i16') {
        pushAsc(String(readI16BE(u8, pos))); pos += 2;
      } else if (t === 'i32') {
        pushAsc(String(readI32BE(u8, pos))); pos += 4;
      } else if (t === 'byte') {
        pushAsc(String(u8[pos])); pos += 1;
      } else if (t === 'bool') {
        pushAsc(u8[pos] ? '1' : '0'); pos += 1;
      } else if (t === 'string') {
        var r = readStr(u8, pos); pushBytes(r.bytes); pos = r.next;
      } else if (t === 'bin') {
        var blen = readU16BE(u8, pos); pos += 2;
        var hex = '';
        for (var j = 0; j < blen; j++) {
          var b = u8[pos + j];
          hex += (b < 16 ? '0' : '') + b.toString(16);
        }
        pos += blen;
        pushAsc(hex);
      }
      chunks.push(13, 10); // 值行结束 + \r\n
    }
    return new Uint8Array(chunks);
  }

  var api = { isBinaryDxf: isBinaryDxf, binaryToText: binaryToText, SENTINEL: SENTINEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DxfBinary = api;
})(typeof window !== 'undefined' ? window : this);
