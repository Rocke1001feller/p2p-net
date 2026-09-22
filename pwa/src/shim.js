// shim.js —— 注入到被隧道化的 HTML 中（在目标应用任何脚本之前执行，经 SW 以 <script> 内联）。
// 职责（POC shim v1 全量平移 + M1 BASE 前缀包装）：
//  ① 禁掉目标应用自己的 Service Worker 注册（防顶掉代理 SW）
//  ② 同源 WebSocket 隧道化（ws-open/ws-msg/ws-close 帧 → 父 shell → DataChannel → host）
//  ③ BASE 前缀包装（v2 增量）：iframe 页面真实地址是 /s/<port>/，而页面代码以为自己在 / ——
//     同源绝对路径 /x 必须改写为 /s/<port>/x 才能落进 SW scope 进隧道。包装四件套：
//     fetch / XMLHttpRequest.open / EventSource / history.pushState+replaceState。
//     （location.href 的读值无法用 Proxy 伪装——plan 关键设计 1 已裁决：不做 location 伪装，
//      暴露 window.__p2pnetBase 供页面自查，逐条记录包装不到的 API 进验收清单。）
// 本文件以 ?raw 方式被 sw.ts 内联打包，必须保持：无 import/export、无 TS 语法、单文件自包含。
(function () {
  'use strict';
  var BASE = window.__p2pnetBase || '';               // 由 SW 注入：<script>window.__p2pnetBase='/s/<port>';…
  var MARK = '__p2pnet';                               // iframe ↔ shell postMessage 协议标记（v2 起 __poc 退役）

  // ---- ① 禁 SW 注册（与 POC 相同语义）----
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function () {
        console.info('[p2pnet-shim] serviceWorker.register 已拦截');
        return new Promise(function () {});
      };
      navigator.serviceWorker.getRegistration = function () { return Promise.resolve(undefined); };
      navigator.serviceWorker.getRegistrations = function () { return Promise.resolve([]); };
    }
  } catch (e) { /* 忽略：非安全上下文等场景 */ }

  // ---- ③ BASE 前缀改写（fetch/XHR/EventSource/pushState 共用）----
  // 规则：同源绝对路径 /x → BASE + /x；已是 BASE 前缀的不动；相对路径与跨源 URL 不动
  //（相对路径由浏览器按 document base 解析，天然落进 /s/<port>/ scope）。
  function needsRewrite(u) {
    if (!u) return null;
    try {
      var parsed = new URL(u, location.href);
      if (parsed.origin !== location.origin) return null;
      var pathOnly = parsed.pathname + parsed.search + parsed.hash;
      if (parsed.pathname === BASE || parsed.pathname.indexOf(BASE + '/') === 0) return null;
      if (parsed.pathname.charAt(0) !== '/') return null;
      return parsed.origin + BASE + pathOnly;
    } catch (e) { return null; }
  }

  var NativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') {
        var rewritten = needsRewrite(input);
        if (rewritten) return NativeFetch.call(window, rewritten, init);
      } else if (input && typeof URL !== 'undefined' && input instanceof URL) {
        var rewrittenUrl = needsRewrite(input.href);
        if (rewrittenUrl) return NativeFetch.call(window, rewrittenUrl, init);
      } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
        var rewrittenReq = needsRewrite(input.url);
        if (rewrittenReq) return NativeFetch.call(window, new Request(rewrittenReq, input));
      }
    } catch (e) { /* 改写失败按原样放行，由 SW 白名单/隧道兜底 */ }
    return NativeFetch.call(window, input, init);
  };
  try { window.fetch.prototype = NativeFetch.prototype; } catch (e) { /* Request 构造探测兼容 */ }

  var NativeXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    try {
      var rewritten = needsRewrite(typeof url === 'string' ? url : (url && url.href) || '');
      if (rewritten) return NativeXHROpen.apply(this, [method, rewritten].concat(rest));
    } catch (e) { /* 忽略 */ }
    return NativeXHROpen.apply(this, arguments);
  };

  if (window.EventSource) {
    var NativeEventSource = window.EventSource;
    window.EventSource = function (url, cfg) {
      var rewritten = needsRewrite(typeof url === 'string' ? url : (url && url.href) || '');
      return new NativeEventSource(rewritten || url, cfg);
    };
    try {
      window.EventSource.prototype = NativeEventSource.prototype;
      Object.defineProperty(window.EventSource, 'name', { value: 'EventSource' });
    } catch (e) { /* 忽略 */ }
  }

  if (history && history.pushState) {
    var wrapHistory = function (nativeFn) {
      return function (state, title, url) {
        try {
          var rewritten = needsRewrite(typeof url === 'string' ? url : (url && url.href) || '');
          return nativeFn.call(history, state, title, rewritten || url);
        } catch (e) { return nativeFn.apply(history, arguments); }
      };
    };
    history.pushState = wrapHistory(history.pushState);
    history.replaceState = wrapHistory(history.replaceState);
  }
  console.info('[p2pnet-shim] BASE 前缀包装就位：' + BASE + '（fetch/XHR/EventSource/pushState）');

  // ---- ② WebSocket 隧道（POC TunnelWS 逐字平移，标记改 __p2pnet）----
  var NativeWS = window.WebSocket;
  var seq = 1;
  function emit(self, type, evt) {
    evt = evt || {};
    try { if (typeof self['on' + type] === 'function') self['on' + type](evt); } catch (e) { /* 用户回调异常不外泄 */ }
    var ls = self._ls && self._ls[type];
    if (ls) for (var i = 0; i < ls.length; i++) try { ls[i].call(self, evt); } catch (e) { /* 同上 */ }
  }
  function TunnelWS(url, protocols) {
    var u = new URL(url, location.href);
    if (u.host !== location.host) return new NativeWS(url, protocols); // 非同源走原生（逃生门）
    var self = this;
    self.url = url; self.protocol = ''; self.extensions = ''; self.binaryType = 'blob';
    self.bufferedAmount = 0; self.readyState = 0; // CONNECTING
    self.onopen = null; self.onmessage = null; self.onerror = null; self.onclose = null;
    self._ls = {}; self._id = 'w' + seq++;
    window.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || m[MARK] !== true || m.wid !== self._id) return;
      if (m.k === 'ws-open-ok') { self.readyState = 1; emit(self, 'open', { type: 'open' }); }
      else if (m.k === 'ws-open-err') { emit(self, 'error', { type: 'error' }); self.readyState = 3; emit(self, 'close', { type: 'close', code: 1006, reason: 'tunnel open failed', wasClean: false }); }
      else if (m.k === 'ws-msg') {
        var data = m.text !== undefined ? m.text : b64ToBlob(m.dataB64);
        emit(self, 'message', { type: 'message', data: data, origin: location.origin });
      }
      else if (m.k === 'ws-close') { self.readyState = 3; emit(self, 'close', { type: 'close', code: m.code || 1000, reason: m.reason || '', wasClean: true }); }
    });
    post({ [MARK]: true, k: 'ws-open', wid: self._id, path: u.pathname + u.search });
  }
  function post(m) { (window.parent !== window ? window.parent : window).postMessage(m, location.origin); }
  function b64ToU8(b) { var s = atob(b); var u8 = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
  function u8ToB64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64ToBlob(b) { return new Blob([b64ToU8(b)]); }
  TunnelWS.prototype.send = function (data) {
    if (this.readyState !== 1) return;
    if (typeof data === 'string') post({ [MARK]: true, k: 'ws-msg', wid: this._id, text: data });
    else if (data instanceof Blob) { var wid = this._id; data.arrayBuffer().then(function (b) { post({ [MARK]: true, k: 'ws-msg', wid: wid, dataB64: u8ToB64(new Uint8Array(b)) }); }); }
    else post({ [MARK]: true, k: 'ws-msg', wid: this._id, dataB64: u8ToB64(new Uint8Array(data.buffer || data)) });
  };
  TunnelWS.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    post({ [MARK]: true, k: 'ws-close', wid: this._id, code: code || 1000, reason: reason || '' });
    this.readyState = 3; emit(this, 'close', { type: 'close', code: code || 1000, reason: reason || '', wasClean: true });
  };
  TunnelWS.prototype.addEventListener = function (type, fn) { (this._ls[type] = this._ls[type] || []).push(fn); };
  TunnelWS.prototype.removeEventListener = function (type, fn) { var a = this._ls[type] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  TunnelWS.CONNECTING = 0; TunnelWS.OPEN = 1; TunnelWS.CLOSING = 2; TunnelWS.CLOSED = 3;
  TunnelWS.prototype.CONNECTING = 0; TunnelWS.prototype.OPEN = 1; TunnelWS.prototype.CLOSING = 2; TunnelWS.prototype.CLOSED = 3;
  window.WebSocket = TunnelWS;
  console.info('[p2pnet-shim] WebSocket 隧道已就位');
})();
