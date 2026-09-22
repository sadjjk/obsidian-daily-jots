// 钉钉文档专用提取:登录 cookie(来自插件内置会话)+ document/data API 直取 + Slate 转 HTML。
// 实测依据(2026-09-18):私有文档匿名 GET /i/nodes 302,带会话 cookie 200;
// dentryKey 为 16 位 base62;响应顶层 {status,isSuccess,data},package 在 data.documentContent;
// body 为 Slate 序列化数组 [type(string), props(object), ...children],文本在叶子节点字符串元素。
const DINGTALK_ORIGIN = "https://alidocs.dingtalk.com";
const DENTRY_KEY_PATTERN = /"dentryKey"\s*:\s*"([^"]{8,64})"/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132";
const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");
// 无头 Chrome 导出钉钉在线表格:复用 browserclip 浏览器会话(--headless=new + --remote-allow-origins=*)
// + CDP 注入 cookie + 页面内 webpack hack 导出 xlsx。
const NAV_WAIT_MS = 25_000;       // 等 collab WebSocket 建立
const CHUNK_SIZE = 500_000;       // base64 分块取回(每块 500KB)

// 双形态兼容:原生 fetch Response 有 text/json;safeFetch 的自定义 response 只有
// body(async iterable,IncomingMessage),webclip 体系一律用 readLimitedBody 读取。
async function responseText(response, maxBytes = 8 * 1024 * 1024) {
  if (typeof response.text === "function") return response.text();
  const buffer = await readLimitedBody(response, maxBytes);
  return buffer.toString("utf8");
}

async function responseJson(response) {
  if (typeof response.json === "function") return response.json();
  return JSON.parse(await responseText(response));
}

// 匿名访客 cookie jar:GET i/nodes 与 POST document/data 时服务端会 set-cookie,
// 图片(resources/img)请求必须带上这些 cookie,否则返回「暂无权限访问」占位图(实测)。
// 兼容两种响应形态:原生 fetch 的 headers.getSetCookie();safeFetch 的 get("set-cookie")(join 串,按「逗号+name=」启发式拆分)。
function collectSetCookies(response) {
  const headers = response.headers;
  if (headers && typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().filter(Boolean);
  }
  const value = headers && typeof headers.get === "function" ? headers.get("set-cookie") : null;
  if (!value) return [];
  return value.split(/,\s*(?=[A-Za-z_][\w.-]*=)/);
}

function mergeCookieJar(jar, response) {
  for (const line of collectSetCookies(response)) {
    const pair = line.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function jarHeader(jar) {
  return jar && jar.size ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}

function dingtalkError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function requestHeaders(cookieHeader) {
  const headers = {
    "user-agent": UA,
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "referer": `${DINGTALK_ORIGIN}/`,
    "origin": DINGTALK_ORIGIN,
  };
  if (cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

async function resolveDentryKey(url, jar = new Map(), fetchImpl = globalThis.fetch) {
  const previewKey = new URL(url).searchParams.get("dentryKey");
  if (previewKey) return previewKey;
  const response = await fetchImpl(url, { headers: requestHeaders(jarHeader(jar)) });
  if (!response.ok) {
    throw dingtalkError(`钉钉文档页面返回 HTTP ${response.status}:${url}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  const html = await responseText(response);
  const match = html.match(DENTRY_KEY_PATTERN);
  if (!match) {
    throw dingtalkError(`无法从页面提取 dentryKey(私有文档需先在「浏览器会话」面板登录钉钉):${url}`, "DINGTALK_DENTRY_KEY_NOT_FOUND");
  }
  return match[1];
}

async function fetchDocumentData(dentryKey, jar = new Map(), fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${DINGTALK_ORIGIN}/api/document/data`, {
    method: "POST",
    headers: {
      ...requestHeaders(jarHeader(jar)),
      "content-type": "application/json;charset=UTF-8",
      "a-dentry-key": dentryKey,
    },
    body: JSON.stringify({ fetchBody: true }),
  });
  if (!response.ok) {
    throw dingtalkError(`钉钉 document/data 返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  const payload = await responseJson(response);
  if (payload && (payload.isSuccess === false || payload.success === false)) {
    throw dingtalkError("钉钉 document/data 报告 isSuccess=false(权限不足或链接失效)", "DINGTALK_DOCS_API_ERROR");
  }
  return payload;
}

// Slate 序列化节点:[type(string), props(object), ...children];纯字符串即文本(叶子内容)。
// props 不当正文输出;未知节点兜底为递归子节点文本。
function slateNodeToHtml(node) {
  if (typeof node === "string") return escapeHtml(node);
  if (!Array.isArray(node)) return "";
  const [type, props = {}, ...children] = node;
  const inner = children.map(slateNodeToHtml).join("");
  if (type === "h1" || type === "h2" || type === "h3" || type === "h4" || type === "h5" || type === "h6") {
    return `<${type}>${inner}</${type}>`;
  }
  if (type === "heading") {
    const level = Math.min(6, Math.max(1, Number(props && props.level) || 1));
    return `<h${level}>${inner}</h${level}>`;
  }
  if (type === "p") return inner.trim() ? `<p>${inner}</p>` : "";
  // 代码块(实测):["code", {}, [span text [span leaf "多行\n文本"]]],leaf 文本自带 \n;
  // 必须输出 pre/code,否则下游 markdown 转换把换行折叠成空格,代码被拍平
  if (type === "code") return `<pre><code>${inner}</code></pre>`;
  if (type === "img") {
    let src = String((props && props.src) || "");
    if (!src) return "";
    // 文档内嵌图片是站内相对路径(/core/api/resources/img/<hash>),媒体文件是 down.dingtalk.com 完整 URL
    if (src.startsWith("/")) src = `${DINGTALK_ORIGIN}${src}`;
    if (!/^https?:/i.test(src)) return "";
    return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml((props && props.alt) || "")}"></p>`;
  }
  if (type === "span" && props && props["data-type"] === "leaf") {
    let out = inner;
    if (props.bold) out = `<strong>${out}</strong>`;
    if (props.italic) out = `<em>${out}</em>`;
    return out;
  }
  if (type === "a") {
    const href = String((props && props.href) || "");
    return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
  }
  return inner;
}

function parsePackageJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) {
    throw dingtalkError("钉钉文档 package 内容不是合法 JSON", "DINGTALK_PACKAGE_MALFORMED");
  }
}

// payload 为 document/data 的 JSON;兼容 data.resultValue 包裹层与 checkpoint 二次内嵌(实测结构)。
function packageToHtml(payload) {
  let root = payload;
  for (const key of ["data", "resultValue"]) {
    if (root && typeof root === "object" && root[key] && typeof root[key] === "object") root = root[key];
  }
  let content = parsePackageJson(
    root && root.documentContent !== undefined ? root.documentContent
      : root && root.checkpoint ? root.checkpoint.content
      : root ? root.content : undefined,
  );
  if (content && content.checkpoint) content = parsePackageJson(content.checkpoint.content);
  const meta = (root && root.fileMetaInfo) || (content && content.fileMetaInfo) || {};
  const parts = (content && content.parts) || {};
  const values = Object.values(parts);
  // 正文 part:普通文档在 parts.main;知识库(PORTAL)的 note/preview 中 main.data 只有文件元数据,
  // 正文在 UUID key 的 part(实测:ragflow 便签正文在 00000000-…0001 的 data.body)。遍历取首个带 body 的 part。
  const bodyOwner = values.find((part) => part && part.data && Array.isArray(part.data.body)) || parts.main;
  const body = bodyOwner && bodyOwner.data && bodyOwner.data.body;
  if (!body) {
    throw dingtalkError("钉钉文档 package 中未找到正文 body 节点(parts 中无 data.body)", "DINGTALK_PACKAGE_MALFORMED");
  }
  // 标题兜底:fileMetaInfo.name 缺失时,文件名在元数据 part 的 data.fileName(与正文 part 可能不同)
  const metaPart = values.find((part) => part && part.data && part.data.fileName);
  const html = slateNodeToHtml(body).replace(/\n{3,}/g, "\n\n").trim();
  // 实测 fileMetaInfo:creator.nick 为作者昵称,gmtCreate 为文档创建时间(epoch 毫秒)
  const author = String(meta.creator && meta.creator.nick || "");
  const publishedAt = meta.gmtCreate ? localIso(new Date(meta.gmtCreate)) : "";
  return {
    title: String(meta.name || (metaPart && metaPart.data && metaPart.data.fileName) || "钉钉文档"),
    html,
    author,
    publishedAt,
  };
}

// 附件型文档(uni-preview?previewAtta=1):上传的原文件(docx/xlsx/pdf 等),
// 走 /box/api/v2/file/download 拿 OSS 预签名直链,webclip 下载为附件保存。
// 实测(2026-09-22):dentryUuid + version 从 URL 参数取;downloadType=URL_PRE_SIGNATURE 返回 preSignUrls[0]。
function parseAttachmentUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.pathname !== "/uni-preview") return null;
  const params = parsed.searchParams;
  if (params.get("previewAtta") !== "1") return null;
  const dentryUuid = params.get("dentryUuid");
  const version = params.get("version") || "1";
  if (!dentryUuid) return null;
  const extension = (params.get("extension") || "").toLowerCase();
  const fileName = params.get("fileName") || "";
  const fileSize = Number(params.get("fileSize")) || 0;
  return { dentryUuid, version, extension, fileName, fileSize };
}

// 钉钉在线表格(/spreadsheetv2/):collab 服务端存储,无 HTTP 导出 API,
// 用无头 Chrome + 页面内 webpack hack 导出 xlsx(详见 headless-chrome.js)。
function parseSpreadsheetUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (!parsed.pathname.includes("/spreadsheetv2/")) return null;
  const params = parsed.searchParams;
  // dentryKey:优先查询参数,其次路径段(/spreadsheetv2/{dentryKey}/edit)
  const pathSeg = parsed.pathname.split("/spreadsheetv2/")[1] || "";
  const dentryKey = params.get("dentryKey") || pathSeg.split("/")[0] || "";
  const docId = params.get("docId") || params.get("docKey") || "";
  if (!dentryKey) return null;
  // 构造编辑器完整 URL(带必要参数,确保 collab WebSocket 建立)
  const editorUrl = `${DINGTALK_ORIGIN}/spreadsheetv2/${dentryKey}/edit?docId=${encodeURIComponent(docId)}&dentryKey=${encodeURIComponent(dentryKey)}`;
  return { dentryKey, docId, editorUrl };
}

// 钉钉在线表格:无头 Chrome 导出 xlsx,返回 { buffer, fileName }
// headlessExport 通过 module.exports.exportDingtalkSpreadsheet 调用,允许测试注入 mock
async function headlessExport(spreadsheetUrl, cookieHeader, browserSessionManager) {
  if (!cookieHeader) {
    throw dingtalkError("钉钉在线表格导出需要登录 cookie(请先在钉钉文档登录窗口登录)", "DINGTALK_DENTRY_KEY_NOT_FOUND");
  }
  return await module.exports.exportDingtalkSpreadsheet(spreadsheetUrl, cookieHeader, browserSessionManager);
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

// CDP evaluate 简写:Runtime.evaluate 返回 result.result.value(自研与 browserclip 两种 client 通用)
async function cdpEvaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
}

// 把 "name=val; name2=val2" 还原成 CDP cookie 并逐个注入(domain .dingtalk.com)
async function injectDingtalkCookies(client, cookieHeader) {
  const cookies = String(cookieHeader || "").split("; ").map((pair) => {
    const idx = pair.indexOf("=");
    if (idx < 0) return null;
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: ".dingtalk.com", path: "/" };
  }).filter(Boolean);
  for (const c of cookies) { try { await client.send("Network.setCookie", c); } catch (_) {} }
}

// 复用 browserclip 浏览器会话导出(Obsidian 环境已验证的链路:start 带 --remote-allow-origins=*)。
// 与自研 spawn 链路共享 cookie 注入/导航/EXPORT_SCRIPT/分块取回逻辑,仅浏览器生命周期管理不同。
async function exportViaSessionManager(url, cookieHeader, manager) {
  const entry = await manager.start("dingtalk-export", { headless: true, initialUrl: "about:blank" });
  let client;
  try {
    client = await manager.createPage(entry);
    await client.send("Page.enable");
    await client.send("Network.enable");
    await injectDingtalkCookies(client, cookieHeader);
    // 导航到表格编辑器(等 collab WebSocket 建立)
    await client.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, NAV_WAIT_MS));
    // 登录态检测:被跳到登录页说明 cookie 失效
    const title = String(await cdpEvaluate(client, "document.title") || "");
    if (/login|登录|扫码/i.test(title)) {
      const err = new Error("钉钉 cookie 已过期,请重新在钉钉文档登录窗口登录");
      err.code = "DINGTALK_DENTRY_KEY_NOT_FOUND";
      throw err;
    }
    const dlResult = await cdpEvaluate(client, EXPORT_SCRIPT);
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
      const chunk = await cdpEvaluate(client, `window.__exportB64.slice(${i * CHUNK_SIZE}, ${Math.min((i + 1) * CHUNK_SIZE, b64Len)})`);
      b64 += chunk;
    }
    const buffer = Buffer.from(b64, "base64");
    const dentryKeyMatch = url.match(/spreadsheetv2\/([^/?]+)/);
    const fileName = `${dentryKeyMatch ? dentryKeyMatch[1] : "dingtalk-spreadsheet"}.xlsx`;
    return { buffer, fileName, title };
  } finally {
    try { if (client) client.close(); } catch (_) {}
    if (entry.owned) { try { entry.child.kill("SIGTERM"); } catch (_) {} }
  }
}

// 导出钉钉在线表格为 xlsx buffer。返回 { buffer, fileName, title }。
// 浏览器生命周期一律复用 browserclip 会话(Obsidian 环境已验证;带 --remote-allow-origins=*)。
async function exportDingtalkSpreadsheet(url, cookieHeader, browserSessionManager) {
  if (!browserSessionManager || typeof browserSessionManager.start !== "function" || typeof browserSessionManager.createPage !== "function") {
    const err = new Error("钉钉在线表格导出需要浏览器会话管理器(内部错误:webSessionManager 缺失)");
    err.code = "DINGTALK_DOCS_UNREACHABLE";
    throw err;
  }
  return await exportViaSessionManager(url, cookieHeader, browserSessionManager);
}

// 生成 xlsx 文件名:"中间层表基础信息.axls" → "中间层表基础信息.xlsx";去编辑器 title 的 " - xxx" 尾巴与非法文件名字符
function spreadsheetFileName(raw) {
  const base = String(raw || "").split(" - ")[0].replace(/\.axls$/i, "").replace(/[\\/:*?"<>|]/g, "").trim();
  return base ? `${base}.xlsx` : "";
}

// 从 /i/nodes/{nodeId} URL 提取 dentryUuid(nodeId),用于 list_brothers 查询文档类型
function parseNodeDentryUuid(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  const m = parsed.pathname.match(/\/i\/nodes\/([^/?]+)/);
  return m ? m[1] : null;
}

// 调 list_brothers 拿当前 dentry 的 extension/dentryKey/name;extension=axls 表示钉钉表格
async function fetchDentryInfo(dentryUuid, jar = new Map(), fetchImpl = globalThis.fetch) {
  const apiUrl = `${DINGTALK_ORIGIN}/box/api/v2/dentry/list_brothers?dentryUuid=${encodeURIComponent(dentryUuid)}&orderType=SORT_KEY&sortType=desc&prevPageSize=1&nextPageSize=1`;
  const response = await fetchImpl(apiUrl, { headers: requestHeaders(jarHeader(jar)) });
  if (!response.ok) {
    // 401/403 是登录态失效,视为登录错误让 webclip 提示重新登录,而非回落渲染登录页正文
    if (response.status === 401 || response.status === 403) {
      throw dingtalkError("钉钉 cookie 已过期或权限不足(请重新在钉钉文档登录窗口登录)", "DINGTALK_DENTRY_KEY_NOT_FOUND");
    }
    throw dingtalkError(`钉钉 list_brothers 返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  // list_brothers 返回非 JSON(如登录页 HTML)时,返回空 info,走兜底 document/data 流程
  let payload;
  try {
    payload = await responseJson(response);
  } catch (_) {
    return { extension: "", dentryKey: "", name: "" };
  }
  if (payload && (payload.isSuccess === false || payload.success === false)) {
    throw dingtalkError("钉钉 list_brothers 返回失败(权限不足或链接失效)", "DINGTALK_DOCS_API_ERROR");
  }
  const current = (payload && payload.data && payload.data.current) || {};
  return { extension: current.extension || "", dentryKey: current.dentryKey || "", name: current.name || "" };
}

async function fetchDownloadUrl(dentryUuid, version, jar, fetchImpl) {
  const apiUrl = `${DINGTALK_ORIGIN}/box/api/v2/file/download?dentryUuid=${encodeURIComponent(dentryUuid)}&version=${encodeURIComponent(version)}&supportDownloadTypes=URL_PRE_SIGNATURE,HTTP_TO_CENTER&downloadType=URL_PRE_SIGNATURE`;
  const response = await fetchImpl(apiUrl, {
    headers: requestHeaders(jarHeader(jar)),
  });
  if (!response.ok) {
    throw dingtalkError(`钉钉附件下载接口返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  const payload = await responseJson(response);
  if (payload && (payload.isSuccess === false || payload.success === false)) {
    throw dingtalkError("钉钉附件下载接口返回失败(权限不足或链接失效)", "DINGTALK_DOCS_API_ERROR");
  }
  const info = payload?.data?.ossUrlPreSignatureInfo || {};
  const preSignUrls = info.preSignUrls || [];
  if (!preSignUrls.length) {
    throw dingtalkError("钉钉附件下载接口未返回预签名 URL", "DINGTALK_DOCS_API_ERROR");
  }
  const downloadUrl = preSignUrls[0];
  // 从 OSS URL 的 response-content-disposition 参数提取文件名(多层 URL encode)
  let fileName = "";
  try {
    const cdMatch = downloadUrl.match(/response-content-disposition=([^&]+)/);
    if (cdMatch) {
      let decoded = cdMatch[1];
      // OSS URL 参数通常被 encode 了 2-3 次
      for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
      const fnMatch = decoded.match(/filename\*?=([^;]+)/);
      if (fnMatch) fileName = fnMatch[1].replace(/^"(.*)"$/, "$1").trim();
    }
  } catch (_) {}
  return { downloadUrl, fileName };
}

async function extractDingtalkDoc(url, { webSessionManager, fetchImpl = globalThis.fetch } = {}) {
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (!/(^|\.)alidocs\.dingtalk\.com$/.test(hostname)) {
    throw dingtalkError(`非钉钉文档链接:${url}`, "DINGTALK_DOCS_URL_MISMATCH");
  }
  // jar:登录 cookie(若有)+ 提取过程中服务端种的匿名访客 cookie;图片下载必须带后者
  const jar = new Map();
  let cookieHeader = "";
  if (webSessionManager && typeof webSessionManager.collectCookies === "function") {
    cookieHeader = await webSessionManager.collectCookies("dingtalk", `${DINGTALK_ORIGIN}/`);
  }
  if (cookieHeader) {
    for (const pair of cookieHeader.split("; ")) {
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  // 附件型文档(uni-preview?previewAtta=1):上传的原文件,走 /box/api/v2/file/download
  const attachment = parseAttachmentUrl(url);
  if (attachment) {
    const { downloadUrl, fileName: dlFileName } = await fetchDownloadUrl(attachment.dentryUuid, attachment.version, jar, fetchImpl);
    const fileName = attachment.fileName || dlFileName || `${attachment.dentryUuid}.${attachment.extension || "bin"}`;
    const error = new Error(`钉钉附件文档(${attachment.extension || "未知"}格式),已获取下载链接`);
    error.code = "DINGTALK_BINARY_DOC";
    error.downloadUrl = downloadUrl;
    error.fileName = fileName;
    error.meta = { extension: attachment.extension, fileSize: attachment.fileSize };
    throw error;
  }
  // 在线表格(/spreadsheetv2/):无头 Chrome 导出 xlsx,抛 DINGTALK_BINARY_DOC 带 buffer(复用附件落盘)
  const spreadsheet = parseSpreadsheetUrl(url);
  if (spreadsheet) {
    const { buffer, fileName, title } = await headlessExport(spreadsheet.editorUrl, cookieHeader || jarHeader(jar), webSessionManager);
    const finalName = spreadsheetFileName(title) || fileName;
    const error = new Error(`钉钉在线表格(${finalName}),已导出 xlsx`);
    error.code = "DINGTALK_BINARY_DOC";
    error.buffer = buffer;
    error.fileName = finalName;
    error.meta = { extension: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    throw error;
  }
  // 在线文档(/i/nodes):先查 dentry extension,表格(axls)走无头导出,其余走 document/data
  const nodeUuid = parseNodeDentryUuid(url);
  if (nodeUuid) {
    const info = await fetchDentryInfo(nodeUuid, jar, fetchImpl);
    if (info.extension === "axls") {
      const sheetKey = info.dentryKey || await resolveDentryKey(url, jar, fetchImpl);
      const editorUrl = `${DINGTALK_ORIGIN}/spreadsheetv2/${sheetKey}/edit?dentryKey=${encodeURIComponent(sheetKey)}`;
      const { buffer, fileName, title } = await headlessExport(editorUrl, cookieHeader || jarHeader(jar), webSessionManager);
      const finalName = spreadsheetFileName(info.name) || spreadsheetFileName(title) || fileName;
      const error = new Error(`钉钉在线表格(${finalName}),已导出 xlsx`);
      error.code = "DINGTALK_BINARY_DOC";
      error.buffer = buffer;
      error.fileName = finalName;
      error.meta = { extension: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
      throw error;
    }
  }
  // 在线文档(/i/nodes):Slate 结构,走 document/data API 提取
  const dentryKey = await resolveDentryKey(url, jar, fetchImpl);
  const payload = await fetchDocumentData(dentryKey, jar, fetchImpl);
  const { title, html, author, publishedAt } = packageToHtml(payload);
  const mergedCookie = jarHeader(jar);
  const imageHeaders = { cookie: mergedCookie || cookieHeader, "a-dentry-key": dentryKey };
  return { title, html, author, publishedAt, cookieHeader, imageHeaders };
}

module.exports = { resolveDentryKey, fetchDocumentData, packageToHtml, extractDingtalkDoc, parseAttachmentUrl, fetchDownloadUrl, parseSpreadsheetUrl, headlessExport, parseNodeDentryUuid, fetchDentryInfo, exportDingtalkSpreadsheet, spreadsheetFileName };
