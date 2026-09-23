// 腾讯文档(docs.qq.com):docx 走 opendoc 协议提取(tencent-doc-protocol 层);sheet/slide 走腾讯导出流(本文件)。
// 导出流与企微文档(doc.weixin.qq.com)同源但请求构造不同:opendoc 换 globalPadId、form 带 exportType/switches、
// 另有 file/desc 元信息接口(作者/创建时间);轮询/下载复用 protocol 层共享件。错误码 TENCENT_DOCS_*。
const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");
const {
  extractDoc, EXPORT_PAD_TYPES, EXPORT_UA, pollExportFileUrl, downloadExportBuffer,
  parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown,
  tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl,
} = require("./tencent-doc-protocol");

async function extractTencentDoc(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractDoc(url, { sessionService: "tencent", siteName: "腾讯文档", collectSessionCookies, fetchImpl });
}

// 腾讯 sheet/slide 导出流:opendoc 换服务端 globalPadId(URL localId 与之不同,直接用会导错文档)
// → file/desc 元信息 → export_office → 共享轮询/下载。2026-09-22 抓包实测:exportType=0 sheet→xlsx、slide→pptx。
async function exportTencentFile(url, { collectSessionCookies, fetchImpl = globalThis.fetch } = {}) {
  const host = tencentHostForUrl(url);
  if (!host) throw new Error("不是腾讯文档链接");
  const cookie = collectSessionCookies ? await collectSessionCookies("tencent", `https://${host}/`) : "";
  if (!cookie) {
    const error = new Error("腾讯文档表格/幻灯导出需要登录会话:先在浏览器会话中登录腾讯文档后重试");
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  const parsed = new URL(url);
  const localId = parsed.searchParams.get("id") || parsed.pathname.split("/").filter(Boolean).pop();
  if (!localId) throw new Error("无法从链接解析腾讯文档 ID");

  // ① opendoc 换 globalPadId/padType/标题
  const metaUrl = `https://${host}/dop-api/opendoc?id=${encodeURIComponent(localId)}&normal=1&noEscape=1&outformat=1&doc_chunk_flag=1&t=${Date.now()}`;
  const metaResp = await fetchImpl(metaUrl, { headers: { accept: "*/*", cookie, referer: `https://${host}/`, "user-agent": EXPORT_UA } });
  if (!metaResp.ok) throw new Error(`腾讯文档 opendoc 返回 HTTP ${metaResp.status}`);
  const metaText = typeof metaResp.text === "function"
    ? await metaResp.text()
    : (await readLimitedBody(metaResp, 32 * 1024 * 1024)).toString("utf8");
  const globalPadId = metaText.match(/"globalPadId"\s*:\s*"([^"]+)"/)?.[1];
  const padType = metaText.match(/"padType"\s*:\s*"([^"]+)"/)?.[1];
  const initialTitle = (metaText.match(/"initialTitle"\s*:\s*"([^"]+)"/)?.[1] || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const exportType = EXPORT_PAD_TYPES[padType];
  if (!globalPadId || !exportType) {
    const error = new Error(`腾讯文档暂不支持导出该类型(${padType || "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_UNSUPPORTED";
    throw error;
  }

  // ①b 元信息(作者/创建时间):POST /v2/drive/file/desc,file_id 取 globalPadId 的 padId 段;失败静默不阻塞导出
  let meta = { author: "", publishedAt: "" };
  try {
    const padId = globalPadId.includes("$") ? globalPadId.split("$")[1] : globalPadId;
    const descResp = await fetchImpl(`https://${host}/v2/drive/file/desc`, {
      method: "POST",
      headers: { cookie, referer: url, "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "user-agent": EXPORT_UA },
      body: JSON.stringify({ file_id: padId, xsrf: "" }),
    });
    const descText = typeof descResp.text === "function" ? await descResp.text() : (await readLimitedBody(descResp, 1024 * 1024)).toString("utf8");
    const result = JSON.parse(descText)?.result || {};
    const createdMs = Number(result.createTime) || 0;
    meta = { author: result.ownerNick || "", publishedAt: createdMs ? localIso(new Date(createdMs)) : "", title: result.name || "" };
  } catch (_) {}

  // ② 发起导出
  const postResp = await fetchImpl(`https://${host}/v1/export/export_office`, {
    method: "POST",
    headers: { cookie, referer: url, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", "user-agent": EXPORT_UA },
    body: `exportType=0&switches=${encodeURIComponent(JSON.stringify({ embedFonts: false }))}&exportSource=client&docId=${encodeURIComponent(globalPadId)}&version=2`,
  });
  const postText = typeof postResp.text === "function" ? await postResp.text() : (await readLimitedBody(postResp, 1024 * 1024)).toString("utf8");
  let postJson; try { postJson = JSON.parse(postText); } catch (_) { postJson = {}; }
  if (postJson.ret !== 0 || !postJson.operationId) {
    // captcha 类失败(频控/风控)无法自动绕过 → 透传提示而非静默回落渲染
    if (postJson.ret === 520112 || /captcha/i.test(postJson.msg || "")) {
      const error = new Error("腾讯文档导出触发验证码风控:请几小时后重试,或在浏览器打开文档手动下载后拖入 Obsidian");
      error.code = "DOCS_EXPORT_CAPTCHA";
      throw error;
    }
    const error = new Error(`腾讯文档导出请求失败(ret=${postJson.ret ?? "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_FAILED";
    throw error;
  }

  // ③④ 共享轮询 + 下载
  const fileUrl = await pollExportFileUrl(host, postJson.operationId, url, cookie, fetchImpl, "腾讯文档", { failedCode: "TENCENT_DOCS_EXPORT_FAILED", timeoutCode: "TENCENT_DOCS_EXPORT_TIMEOUT" });
  await downloadExportBuffer(fileUrl, fetchImpl, "腾讯文档", { padType, exportType, initialTitle, localId, author: meta.author, publishedAt: meta.publishedAt, binaryCode: "TENCENT_DOCS_BINARY" });
}

module.exports = {
  extractTencentDoc,
  extractTencentFileExportForTencent: exportTencentFile,
  parseTencentDocPayload,
  stripTencentChrome,
  tencentDocApiUrl,
  tencentDocToMarkdown,
  tencentHostForUrl,
  tencentSessionServiceForUrl,
  tencentSiteNameForUrl,
};
