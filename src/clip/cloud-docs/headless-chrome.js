"use strict";

// 钉钉在线表格无头导出:系统 Chrome --headless=new + CDP 注入 cookie + 页面内 webpack hack
// 导出 xlsx。不弹窗、不依赖用户打开钉钉窗口。参考 /tmp/dingtalk-headless-v3.mjs(已验证)。
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const KNOWN_CHROME_PATHS = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  : process.platform === "win32"
    ? [path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

const TMP_PROFILE = "/tmp/dingtalk-headless-profile";
const NAV_WAIT_MS = 25_000;       // 等 collab WebSocket 建立
const CHUNK_SIZE = 500_000;       // base64 分块取回(每块 500KB)

function findChrome() {
  for (const p of KNOWN_CHROME_PATHS) {
    try { fs.accessSync(p); return p; } catch (_) {}
  }
  return null;
}

// 选取空闲端口:启动临时 server 拿 port 后立即关闭
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// 轮询 /json/list 直到返回第一个 page tab(Chrome 启动需要时间)
async function findPageTab(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await resp.json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("无头 Chrome 未在超时内暴露调试 page tab");
}

// CDP 连接:封装 send/onmessage,返回 { send, ev, close }
function connectCdp(ws) {
  let mid = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, no } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? no(new Error(m.error.message)) : ok(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const id = ++mid;
    pending.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = (expr) => send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
    .then((r) => r?.result?.value);
  return { send, ev, close: () => ws.close() };
}

// 页面内导出脚本:webpack hack → store → controller → serialize → handleUpload → 页面内下载 → base64
const EXPORT_SCRIPT = `(async function(){
  try {
    var wr; window.webpackChunkflex_table_app.push([["__hack__"], {}, function(r){ wr = r; }]);
    var store = wr(559300).z();
    var state = store.getState();
    var controller = state.editor && state.editor.editor && state.editor.editor.controller;
    if (!controller) return JSON.stringify({err: "no controller(页面未就绪或结构变更)"});
    controller.model.book.loadAllSheets();
    var p = controller.model.serialize({compatible: "excel"});
    var mod = await wr.e(74354).then(wr.bind(wr, 474354));
    var enumMod = wr(551443);
    var ossUrl = await mod.handleUpload(new File([p], "doc"), enumMod.Wz.TMP_CP, "dingTalksheetToxlsx", undefined, undefined);
    var r = await fetch(ossUrl);
    var buf = await r.arrayBuffer();
    var u8 = new Uint8Array(buf);
    var b64 = await new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){
        var result = reader.result;
        var idx = result.indexOf(",");
        resolve(result.slice(idx + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(new Blob([u8]));
    });
    window.__exportB64 = b64;
    return JSON.stringify({ok: true, size: buf.byteLength, isZip: u8[0]===0x50 && u8[1]===0x4b, b64Len: b64.length});
  } catch(e) { return JSON.stringify({err: (e && e.message) || String(e)}); }
})()`;

// 导出钉钉在线表格为 xlsx buffer。返回 { buffer, fileName }。
async function exportDingtalkSpreadsheet(url, cookieHeader) {
  const chromePath = findChrome();
  if (!chromePath) {
    const err = new Error("未找到系统 Chrome,无法导出钉钉在线表格(请安装 Google Chrome)");
    err.code = "DINGTALK_DOCS_UNREACHABLE";
    throw err;
  }
  const port = await pickPort();
  const proc = childProcess.spawn(chromePath, [
    `--headless=new`, `--remote-debugging-port=${port}`,
    `--user-data-dir=${TMP_PROFILE}`, "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let ws, cdp;
  try {
    await new Promise((r) => setTimeout(r, 3_000));   // 等 Chrome 启动
    const page = await findPageTab(port);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    cdp = connectCdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    // 注入 cookie(从 cookieHeader "name=val; name2=val2" 还原,domain .dingtalk.com)
    const cookies = String(cookieHeader || "").split("; ").map((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 0) return null;
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: ".dingtalk.com", path: "/" };
    }).filter(Boolean);
    for (const c of cookies) { try { await cdp.send("Network.setCookie", c); } catch (_) {} }

    // 导航到表格编辑器(等 collab WebSocket 建立)
    await cdp.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, NAV_WAIT_MS));

    // 登录态检测:被跳到登录页说明 cookie 失效
    const title = String(await cdp.ev("document.title") || "");
    if (/login|登录|扫码/i.test(title)) {
      const err = new Error("钉钉 cookie 已过期,请重新在钉钉文档登录窗口登录");
      err.code = "DINGTALK_DENTRY_KEY_NOT_FOUND";
      throw err;
    }

    // 页面内执行导出脚本
    const dlResult = await cdp.ev(EXPORT_SCRIPT);
    const dlParsed = JSON.parse(dlResult);
    if (!dlParsed.ok) {
      const err = new Error(`钉钉在线表格导出失败:${dlParsed.err || "未知错误"}`);
      err.code = "DINGTALK_DOCS_API_ERROR";
      throw err;
    }
    if (!dlParsed.isZip) {
      const err = new Error("钉钉在线表格导出结果非 xlsx(zip)格式");
      err.code = "DINGTALK_DOCS_API_ERROR";
      throw err;
    }

    // 分块取回 base64 → Buffer
    const b64Len = dlParsed.b64Len;
    const chunks = Math.ceil(b64Len / CHUNK_SIZE);
    let b64 = "";
    for (let i = 0; i < chunks; i++) {
      const chunk = await cdp.ev(`window.__exportB64.slice(${i * CHUNK_SIZE}, ${Math.min((i + 1) * CHUNK_SIZE, b64Len)})`);
      b64 += chunk;
    }
    const buffer = Buffer.from(b64, "base64");

    // 文件名:从 URL 路径段取 dentryKey,默认 xlsx
    const dentryKeyMatch = url.match(/spreadsheetv2\/([^/?]+)/);
    const fileName = `${dentryKeyMatch ? dentryKeyMatch[1] : "dingtalk-spreadsheet"}.xlsx`;
    return { buffer, fileName };
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { proc.kill("SIGTERM"); } catch (_) {}
  }
}

module.exports = { exportDingtalkSpreadsheet, findChrome, pickPort };
