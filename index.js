"use strict";

/**
 * SiYuan 插件：DXF 编辑器 / 预览（集成版，单一安装包）
 *
 * 设计（单一交付物）：
 *  - 本插件包内含完整 viewer（widget-assets/，即纯前端 Canvas2D 的 dxf-editor）。
 *  - 插件加载时把 widget-assets/ 部署到思源 widgets 目录
 *    （data/widgets/siyuan-dxf-editor/），从而复用思源已验证的 /widgets/<name>/ 静态路由。
 *  - dock 的 iframe 指向 /widgets/siyuan-dxf-editor/index.html?dock=1；
 *    嵌入当前笔记用 {{iframe /widgets/siyuan-dxf-editor/index.html?embed=1&asset=...}}。
 *  - 点击 .dxf 附件：捕获阶段 preventDefault + 打开右侧 dock 预览，从而【拦截思源自带
 *    把 DXF 当纯文本预览】的默认行为。
 *  - 右键菜单：提供「用 DXF 预览打开」与「以 DXF 挂件嵌入当前笔记」。
 *
 * 交互与消息协议（与 viewer 约定）：
 *  - viewer → 插件：{type:'dxf-ready'} 表示自身已就绪，可下发文件。
 *  - 插件 → viewer：{type:'dxf-load', asset:'/assets/xxx.dxf'} 切换文件。
 *  - viewer 启动若带 ?asset= 则自动 fetch 加载（dock 初次、embed 都用此方式）。
 */

const siyuan = require("siyuan");
const Plugin = siyuan.Plugin;
// 思源插件运行在渲染进程，Node 内建模块须用 window.require 取（与 siyuan-folder-tree 等官方插件一致）
const fs = window.require("fs");
const path = window.require("path");

const PLUGIN_NAME = "siyuan-dxf-editor";
const WIDGET_NAME = "siyuan-dxf-editor";          // 部署后的 widgets 子目录名（与插件同名）
const WIDGET_URL = "/widgets/" + WIDGET_NAME + "/index.html?dock=1";
const EMBED_BASE = "/widgets/" + WIDGET_NAME + "/index.html?embed=1&asset=";
const DOCK_TYPE = "dock";
const HOTKEY = "⇧⌘D";
const DOCK_POSITION = "RightBottom";
const CAD_EXT = /\.(dxf|dwg)(\?|#|$)/i;
const DEPLOY_VERSION = "1.0.27";                   // 与 plugin.json 保持一致；每次发布都要同步 plugins/.../widget-assets/ 并提升此版本

class DxfEditorPlugin extends Plugin {
  constructor(options, api) {
    super(options, api);
    this._iframe = null;
    this._dockModel = null;
    this._dockId = this.name + DOCK_TYPE;
    this._dockVisible = false;
    this._dockContainer = this._containerForPosition(DOCK_POSITION);
    this._widgetReady = false;
    this._pendingAsset = null;
    this._dockAssetForInit = null;
    this._onClick = this._onClick.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onMenuLink = this._onMenuLink.bind(this);
    this._onMenuContent = this._onMenuContent.bind(this);
    this._onMenuDoctree = this._onMenuDoctree.bind(this);
  }

  _containerForPosition(p) {
    if (/^left/i.test(p)) return "leftDock";
    if (/^bottom/i.test(p)) return "bottomDock";
    return "rightDock";
  }

  _layout() {
    return (this.app && this.app.layout) || (window.siyuan && window.siyuan.layout) || null;
  }

  // ---- 把内置 viewer 部署到 widgets 目录（仅首次或版本变化时）----
  _deployWidget() {
    try {
      const src = this._findWidgetAssetsDir();
      if (!src) {
        console.error("[dxf-editor] 找不到 widget-assets，无法部署 viewer");
        this._debugLog("找不到 widget-assets");
        return false;
      }
      const dest = this._findWidgetsDeployDir();
      if (!dest) {
        console.error("[dxf-editor] 无法确定 widgets 部署目录");
        this._debugLog("无法确定 widgets 部署目录");
        return false;
      }
      const widgetsDir = path.dirname(dest);
      const marker = path.join(dest, ".deployed-version");
      let needCopy = false;
      if (!fs.existsSync(dest) || !fs.existsSync(marker)) needCopy = true;
      else {
        try { if (fs.readFileSync(marker, "utf8").trim() !== DEPLOY_VERSION) needCopy = true; }
        catch (e) { needCopy = true; }
      }
      if (!needCopy) return true;
      if (!fs.existsSync(widgetsDir)) fs.mkdirSync(widgetsDir, { recursive: true });
      this._copyDir(src, dest);
      fs.writeFileSync(marker, DEPLOY_VERSION, "utf8");
      console.log("[dxf-editor] viewer 已部署到", dest);
      this._debugLog("部署成功: " + dest);
      return true;
    } catch (e) {
      console.error("[dxf-editor] 部署 viewer 失败：", e);
      this._debugLog("部署失败: " + (e && e.message));
      return false;
    }
  }

  _findWidgetAssetsDir() {
    const candidates = [];
    if (this.path) candidates.push(path.join(this.path, "widget-assets"));
    if (this.pluginDir) candidates.push(path.join(this.pluginDir, "widget-assets"));
    if (__dirname) candidates.push(path.join(__dirname, "widget-assets"));
    const ws = this._workspaceDir();
    if (ws) candidates.push(path.join(ws, "data", "plugins", PLUGIN_NAME, "widget-assets"));
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    console.error("[dxf-editor] widget-assets 候选均不存在：", candidates);
    return null;
  }

  _findWidgetsDeployDir() {
    const ws = this._workspaceDir();
    if (ws) return path.join(ws, "data", "widgets", WIDGET_NAME);
    if (this.path) return path.join(this.path, "..", "widgets", WIDGET_NAME);
    if (__dirname) return path.join(__dirname, "..", "widgets", WIDGET_NAME);
    return null;
  }

  _workspaceDir() {
    try {
      const cfg = window.siyuan && window.siyuan.config;
      if (cfg && cfg.system && cfg.system.workspaceDir) return cfg.system.workspaceDir;
    } catch (e) {}
    try {
      let dir = this.path || __dirname;
      if (!dir) return null;
      for (let i = 0; i < 5; i++) {
        const conf = path.join(dir, "conf", "conf.json");
        if (fs.existsSync(conf)) {
          const json = JSON.parse(fs.readFileSync(conf, "utf8"));
          if (json.system && json.system.workspaceDir) return json.system.workspaceDir;
        }
        dir = path.dirname(dir);
      }
    } catch (e) {}
    return null;
  }

  _debugLog(msg) {
    try {
      const ws = this._workspaceDir();
      if (!ws) return;
      const logFile = path.join(ws, "data", "plugins", PLUGIN_NAME, "deploy.log");
      fs.appendFileSync(logFile, new Date().toISOString() + " " + msg + "\n", "utf8");
    } catch (e) {}
  }

  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) this._copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  }

  async onload() {
    // 先部署 viewer，再建 dock
    this._deployWidget();

    this._createDock();

    document.addEventListener("click", this._onClick, true);
    window.addEventListener("message", this._onMessage);
    this.eventBus.on("open-menu-link", this._onMenuLink);
    this.eventBus.on("open-menu-content", this._onMenuContent);
    this.eventBus.on("open-menu-doctree", this._onMenuDoctree);

    this.addTopBar({
      icon: "iconImages",
      title: "DXF 预览",
      callback: () => this._openDock()
    });

    this.addCommand({
      langKey: "openPanel",
      hotkey: HOTKEY,
      callback: () => this._openDock()
    });
  }

  onunload() {
    document.removeEventListener("click", this._onClick, true);
    window.removeEventListener("message", this._onMessage);
    this.eventBus.off("open-menu-link", this._onMenuLink);
    this.eventBus.off("open-menu-content", this._onMenuContent);
    this.eventBus.off("open-menu-doctree", this._onMenuDoctree);
  }

  _createDock() {
    try {
      this.addDock({
        config: {
          position: DOCK_POSITION,
          size: { width: 560, height: 0 },
          icon: "iconImages",
          title: "DXF 预览",
          hotkey: HOTKEY,
          index: 1
        },
        data: {},
        type: DOCK_TYPE,
        init: (dock) => {
          this._dockModel = dock;
          this._dockVisible = true;
          const iframe = document.createElement("iframe");
          let src = WIDGET_URL;
          if (this._dockAssetForInit) src += "&asset=" + encodeURIComponent(this._dockAssetForInit);
          iframe.src = src;
          iframe.style.cssText = "width:100%;height:100%;border:0;background:#1e1e1e;";
          iframe.setAttribute(
            "sandbox",
            "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          );
          dock.element.appendChild(iframe);
          this._iframe = iframe;
        },
        destroy: () => {
          this._dockVisible = false;
          this._dockModel = null;
          this._iframe = null;
        }
      });
    } catch (e) {
      console.error("[dxf-editor] addDock 失败:", e);
    }
  }

  _isDockVisible() {
    const panel = document.querySelector(".sy__" + this._dockId);
    if (!panel) return false;
    if (panel.classList.contains("fn__none")) return false;
    if (panel.offsetParent === null) return false;
    return panel.getBoundingClientRect().width > 0;
  }

  _dock() {
    const layout = this._layout();
    return layout && layout[this._dockContainer];
  }

  _openDock() {
    const dock = this._dock();
    if (!dock || typeof dock.toggleModel !== "function") return;
    const tryOpen = () => {
      const d = this._dock();
      if (d && typeof d.toggleModel === "function") {
        try { d.toggleModel(this._dockId); } catch (e) {
          console.error("[dxf-editor] 打开面板失败:", e);
        }
      }
    };
    try { dock.toggleModel(this._dockId, false, false, true); } catch (e) {}
    setTimeout(() => {
      tryOpen();
      setTimeout(() => {
        if (!this._isDockVisible()) tryOpen();
      }, 450);
    }, 900);
  }

  _closeDock() {
    const dock = this._dock();
    if (!dock || typeof dock.toggleModel !== "function") return;
    const tryClose = () => {
      try { dock.toggleModel(this._dockId, false, false, true); } catch (e) {}
    };
    tryClose();
    setTimeout(() => {
      if (this._isDockVisible()) tryClose();
    }, 450);
  }

  _post(msg) {
    if (this._iframe && this._iframe.contentWindow) {
      try { this._iframe.contentWindow.postMessage(msg, "*"); } catch (e) {}
    }
  }

  _resolveAssetUrl(href) {
    if (!href) return null;
    const clean = href.split("#")[0].split("?")[0];
    if (/^https?:\/\//i.test(clean)) return clean;
    const m = clean.match(/\/?assets\/(.+)$/i);
    if (m) return "/assets/" + m[1];
    if (clean.startsWith("/")) return clean;
    return "/" + clean.replace(/^\/+/, "");
  }

  _isCad(href) {
    return CAD_EXT.test(href || "");
  }

  _cadName(el) {
    if (!el || !el.getAttribute) return "";
    return (
      el.getAttribute("data-href") ||
      el.getAttribute("title") ||
      el.getAttribute("aria-label") ||
      (el.textContent || "").trim()
    );
  }

  _findCadAnchor(scopeEl) {
    if (!scopeEl || !scopeEl.querySelectorAll) return null;
    const self = scopeEl.closest && scopeEl.closest('[data-type="file"]');
    if (self) {
      const href = self.getAttribute("data-href") || self.getAttribute("href");
      if (this._isCad(href)) return { href, name: this._cadName(self) };
    }
    if (scopeEl.getAttribute && scopeEl.getAttribute("data-type") === "file") {
      const href = scopeEl.getAttribute("data-href") || scopeEl.getAttribute("href");
      if (this._isCad(href)) return { href, name: this._cadName(scopeEl) };
    }
    const cands = scopeEl.querySelectorAll('[data-type="file"][data-href], [data-type="file"][href]');
    for (const c of cands) {
      const href = c.getAttribute("data-href") || c.getAttribute("href");
      if (this._isCad(href)) return { href, name: this._cadName(c) };
    }
    return null;
  }

  _findCadInBlock(blockEl, protyle) {
    if (!blockEl) return null;
    const hit = this._findCadAnchor(blockEl);
    if (hit) return { ...hit, protyle };
    const list = blockEl.parentElement && blockEl.parentElement.children;
    if (list && list.length) {
      for (const sib of list) {
        if (sib === blockEl) continue;
        const h = this._findCadAnchor(sib);
        if (h) return { ...h, protyle };
      }
    }
    return null;
  }

  _addMenuItems(menu, hit, protyle, element) {
    if (!menu || !hit) return;
    const { href } = hit;
    try {
      menu.addItem({
        icon: "iconImages",
        label: "用 DXF 预览打开",
        click: () => this._openAsset(href)
      });
    } catch (e) {}
    try {
      menu.addItem({
        icon: "iconSQL",
        label: "以 DXF 挂件嵌入当前笔记",
        click: () => this._embedAsset(href, protyle, element)
      });
    } catch (e) {}
  }

  _openAsset(href) {
    const asset = this._resolveAssetUrl(href);
    if (!asset) return;
    this._pendingAsset = asset;
    this._dockAssetForInit = asset;
    this._openDock();
    if (this._widgetReady) this._flush();
    else setTimeout(() => this._flush(), 1500);
  }

  _flush() {
    if (this._pendingAsset && this._iframe && this._iframe.contentWindow) {
      this._post({ type: "dxf-load", asset: this._pendingAsset });
      this._pendingAsset = null;
    }
  }

  _embedAsset(href, protyle, element) {
    const asset = this._resolveAssetUrl(href);
    if (!asset) {
      this._tip("无法解析 DXF 资源路径", "error");
      return;
    }

    console.log("[dxf-editor] 开始嵌入 asset:", asset);
    this._debugLog("嵌入开始: " + asset);

    // 插件+挂件方式（v1.0.2 原始思路）：直接通过当前编辑器 Protyle 实例插入 NodeWidget HTML。
    // v3.8.1 右键菜单传进来的 protyle 通常是 IProtyle 接口，需要先 getInstance() 拿到真实 Protyle 实例。
    let iprotyle = protyle;
    if (!iprotyle || !iprotyle.element) {
      iprotyle = this._protyleFromElement(element);
    }
    if (!iprotyle || !iprotyle.element) {
      iprotyle = this._findActiveProtyle();
    }

    const instance = this._getProtyleInstance(iprotyle);
    if (!instance) {
      this._tip("未找到可插入的笔记编辑器，请先打开目标文档并点击正文区域获取焦点", "error");
      this._debugLog("嵌入失败: 未找到 Protyle 实例");
      return;
    }

    const src = EMBED_BASE + encodeURIComponent(asset);
    this._insertWidget(src, instance);
  }

  _getProtyleInstance(iprotyle) {
    if (!iprotyle) return null;
    // 已经是真实 Protyle 实例
    if (typeof iprotyle.insert === "function") return iprotyle;
    // IProtyle 接口通过 getInstance() 返回真实实例
    if (typeof iprotyle.getInstance === "function") {
      try {
        const inst = iprotyle.getInstance();
        if (inst && typeof inst.insert === "function") return inst;
      } catch (e) {}
    }
    // 某些版本在 DOM 元素上挂的是 IProtyle
    if (iprotyle.element) {
      const domInst = this._getProtyleInstance(iprotyle.element.__protyle || iprotyle.element._protyle);
      if (domInst) return domInst;
    }
    return null;
  }

  _insertWidget(src, instance) {
    // 参考集市 embedding-pdf/embedding-html 插件：直接插入 iframe HTML（不是 NodeWidget 块），
    // 并先 deleteContents 清空当前选区，避免插入位置异常导致页面看不到。
    const iframeHtml =
      '<iframe sandbox="allow-forms allow-presentation allow-same-origin allow-scripts allow-modals" ' +
      'src="' + src + '" data-src="" border="0" frameborder="no" framespacing="0" ' +
      'allowfullscreen="true" style="width:100%;height:600px;"></iframe>';

    try {
      // 清除当前光标选区，确保 iframe 插入到可见位置
      if (instance.protyle && instance.protyle.toolbar && instance.protyle.toolbar.range) {
        try { instance.protyle.toolbar.range.deleteContents(); } catch (e) {}
      }
      instance.insert(iframeHtml, true);
      this._tip("DXF 挂件已嵌入当前笔记");
      this._debugLog("前端 Protyle.insert 嵌入成功");
    } catch (e) {
      console.error("[dxf-editor] 前端插入失败:", e);
      this._debugLog("前端插入失败: " + (e && e.message));
      this._fallbackCopy(src, "前端插入失败：" + (e && e.message));
    }
  }

  _fallbackCopy(src, errMsg) {
    const fallbackUrl = window.location.origin + src;
    this._copyToClipboard(fallbackUrl);
    this._tip("嵌入失败" + (errMsg ? "：" + errMsg : "") + "；嵌入链接已复制到剪贴板", "error");
    this._debugLog("复制回退 URL: " + fallbackUrl);
  }

  _copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
    } catch (e) {}
  }

  _protyleFromElement(el) {
    if (!el || !el.closest) return null;
    try {
      const protyleEl = el.closest(".protyle");
      if (!protyleEl) return null;
      return protyleEl.__protyle || protyleEl._protyle || null;
    } catch (e) {
      return null;
    }
  }

  _findActiveProtyle() {
    try {
      if (siyuan.getActiveEditor) {
        const editor = siyuan.getActiveEditor();
        if (editor && editor.protyle) return editor.protyle;
        // 某些版本直接返回 protyle
        if (editor && editor.element) return editor;
      }
    } catch (e) {}
    // 最后尝试全局 layout 中找当前活动编辑器
    try {
      const layout = this._layout();
      if (!layout || !layout.children) return null;
      const find = (nodes) => {
        for (const n of nodes) {
          if (!n) continue;
          if (n.model && n.model.protyle) return n.model.protyle;
          if (n.protyle) return n.protyle;
          if (n.children) { const r = find(n.children); if (r) return r; }
        }
        return null;
      };
      return find(layout.children);
    } catch (e) { return null; }
  }

  _tip(msg, type) {
    try {
      let siyuan = null;
      try { siyuan = require("siyuan"); } catch (e) {}
      if (!siyuan) {
        try { siyuan = window.siyuan; } catch (e) {}
      }
      if (siyuan && siyuan.showMessage) {
        siyuan.showMessage(msg, type === "error" ? 3000 : 2000, type);
        return;
      }
      if (siyuan && siyuan.pushMsg) {
        siyuan.pushMsg({ msg, timeout: 3000 });
        return;
      }
    } catch (e) {}
    // 最末 fallback
    console.log("[dxf-editor] " + msg);
  }

  // === Click capture: 左键直接打开（并拦截思源自带 DXF 文本预览）===
  _onClick(ev) {
    try {
      let el = ev.target;
      while (el && el !== document.body) {
        if (!el.getAttribute) { el = el.parentElement; continue; }
        const href = el.getAttribute("href") || el.getAttribute("data-href");
        const isFile = el.getAttribute("data-type") === "file";
        if ((href && this._isCad(href)) || (isFile && this._isCad(this._cadName(el)))) {
          const target = href || this._cadName(el);
          if (target) {
            ev.preventDefault();
            ev.stopPropagation();
            this._openAsset(target);
          }
          return;
        }
        el = el.parentElement;
      }
    } catch (e) {}
  }

  // === Menu events (SiYuan 3.8.x) ===
  _onMenuLink({ detail }) {
    try {
      const menu = detail && detail.menu;
      const element = detail && detail.element;
      const protyle = detail && detail.protyle;
      if (!menu || !element) return;
      const href = element.getAttribute("href") || element.getAttribute("data-href");
      if (!this._isCad(href)) return;
      this._addMenuItems(menu, { href }, protyle, element);
    } catch (e) {}
  }

  _onMenuContent({ detail }) {
    try {
      const menu = detail && detail.menu;
      const element = detail && detail.element;
      const protyle = detail && detail.protyle;
      if (!menu || !element) return;
      const hit = this._findCadInBlock(element, protyle);
      if (!hit) return;
      this._addMenuItems(menu, hit, protyle, element);
    } catch (e) {}
  }

  _onMenuDoctree({ detail }) {
    try {
      const menu = detail && detail.menu;
      const elements = detail && detail.elements;
      if (!menu || !elements || !elements.length) return;
      let first = null, firstEl = null;
      for (const el of elements) {
        const p = el && (el.getAttribute("data-path") || (el.dataset && el.dataset.path));
        const sub = el && el.querySelector && el.querySelector('[data-type="file"][data-href]');
        const href = sub && (sub.getAttribute("data-href") || sub.getAttribute("href"));
        if (p && /\.dxf$|\.dwg$/i.test(p)) { first = p; firstEl = el; break; }
        if (href && this._isCad(href)) { first = href; firstEl = sub || el; break; }
      }
      if (!first) return;
      const protyle = this._findActiveProtyle();
      this._addMenuItems(menu, { href: first }, protyle, firstEl);
    } catch (e) {}
  }

  _onMessage(ev) {
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "dxf-ready") {
      this._widgetReady = true;
      if (this._pendingAsset) this._flush();
    } else if (m.type === "dxf-close") {
      this._closeDock();
    }
  }
}

module.exports = DxfEditorPlugin;
