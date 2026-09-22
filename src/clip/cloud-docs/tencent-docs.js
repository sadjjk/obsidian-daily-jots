// 腾讯文档(docs.qq.com)壳:会话服务/站点名/提取入口。
// opendoc 协议实现(API URL/mutations 解析/markdown 转换/chrome 清洗)在 tencent-doc-protocol.js,
// 与企微文档(wecom-docs.js)共享同一协议层。
const { extractDoc, extractTencentFileExport, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl } = require("./tencent-doc-protocol");

async function extractTencentDoc(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractDoc(url, { sessionService: "tencent", siteName: "腾讯文档", collectSessionCookies, fetchImpl });
}

// sheet/slide 等二进制类型:导出链(export_office → 轮询 → 下载),与 docx 的 opendoc mutations 解析互斥
async function extractTencentFileExportForTencent(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractTencentFileExport(url, { sessionService: "tencent", siteName: "腾讯文档", collectSessionCookies, fetchImpl });
}

module.exports = { extractTencentDoc, extractTencentFileExportForTencent, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl };
