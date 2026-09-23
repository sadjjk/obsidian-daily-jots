// 企微文档(doc.weixin.qq.com):docx 走 opendoc 协议提取(tencent-doc-protocol 层,与腾讯文档共享但会话独立);
// sheet/slide 走企微导出流(本文件):docId 直接用 URL localId(e3_ 前缀,无需 opendoc 换取)、
// query 带 wedoc_xsrf=1(sid 可省)、form 体带 captcha 占位、轮询带 timestamp;轮询/下载复用 protocol 共享件。
// 错误码 WECOM_DOCS_*(与腾讯 TENCENT_DOCS_* 分离)。
const { readLimitedBody } = require("../../core/network");
const { extractDoc, EXPORT_PAD_TYPES, EXPORT_UA, pollExportFileUrl, downloadExportBuffer, tencentHostForUrl } = require("./tencent-doc-protocol");

async function extractWecomDoc(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractDoc(url, { sessionService: "wecomdoc", siteName: "企微文档", collectSessionCookies, fetchImpl });
}

// 企微 sheet/slide 导出流。2026-09-22 实测:27MB xlsx 一次通过,文件名取 content-disposition;
// 企微无 file/desc 类元信息接口,author/published_at 留空(不猜接口)。
async function exportWecomFile(url, { collectSessionCookies, fetchImpl = globalThis.fetch } = {}) {
  const cookie = collectSessionCookies ? await collectSessionCookies("wecomdoc", "https://doc.weixin.qq.com/") : "";
  if (!cookie) {
    const error = new Error("企微文档表格/幻灯导出需要登录会话:先在浏览器会话中登录企微文档后重试");
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  const parsed = new URL(url);
  const localId = parsed.pathname.split("/").filter(Boolean).pop();
  const padType = (parsed.pathname.match(/\/(sheet|slide)\//) || [])[1];
  const exportType = EXPORT_PAD_TYPES[padType];
  if (!localId || !exportType) {
    const error = new Error(`企微文档暂不支持导出该类型(${padType || "未知"})`);
    error.code = "WECOM_DOCS_EXPORT_UNSUPPORTED";
    throw error;
  }

  // 发起导出(sid 可省,wedoc_xsrf=1 固定值)
  const postResp = await fetchImpl("https://doc.weixin.qq.com/v1/export/export_office?wedoc_xsrf=1", {
    method: "POST",
    headers: { cookie, referer: url, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", "user-agent": EXPORT_UA },
    body: `docId=${encodeURIComponent(localId)}&version=2&captchaTicket=&captchaRandstr=`,
  });
  const postText = typeof postResp.text === "function" ? await postResp.text() : (await readLimitedBody(postResp, 1024 * 1024)).toString("utf8");
  let postJson; try { postJson = JSON.parse(postText); } catch (_) { postJson = {}; }
  if (postJson.ret !== 0 || !postJson.operationId) {
    // 520112/captcha:服务端导出频控(如当日次数上限),要求验证码,无法自动绕过 → 透传提示而非静默渲染空壳
    if (postJson.ret === 520112 || /captcha/i.test(postJson.msg || "")) {
      const error = new Error("企微文档导出触发验证码风控:请几小时后重试,或在浏览器打开文档手动下载后拖入 Obsidian");
      error.code = "DOCS_EXPORT_CAPTCHA";
      throw error;
    }
    const error = new Error(`企微文档导出请求失败(ret=${postJson.ret ?? "未知"})`);
    error.code = "WECOM_DOCS_EXPORT_FAILED";
    throw error;
  }

  // 共享轮询(带 timestamp 防缓存) + 下载
  const fileUrl = await pollExportFileUrl("doc.weixin.qq.com", postJson.operationId, url, cookie, fetchImpl, "企微文档", { withTimestamp: true, failedCode: "WECOM_DOCS_EXPORT_FAILED", timeoutCode: "WECOM_DOCS_EXPORT_TIMEOUT" });
  await downloadExportBuffer(fileUrl, fetchImpl, "企微文档", { padType, exportType, initialTitle: "", localId, author: "", publishedAt: "", binaryCode: "WECOM_DOCS_BINARY" });
}

module.exports = { extractWecomDoc, extractWecomFileExport: exportWecomFile, tencentHostForUrl };
