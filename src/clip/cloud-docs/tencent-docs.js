// 腾讯文档(docs.qq.com)壳:会话服务/站点名/提取入口。
// opendoc 协议实现(API URL/mutations 解析/markdown 转换/chrome 清洗)在 tencent-doc-protocol.js,
// 与企微文档(wecom-docs.js)共享同一协议层。
const { extractDoc, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl } = require("./tencent-doc-protocol");

async function extractTencentDoc(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractDoc(url, { sessionService: "tencent", siteName: "腾讯文档", collectSessionCookies, fetchImpl });
}

module.exports = { extractTencentDoc, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl };
