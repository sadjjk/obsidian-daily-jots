// 企微文档(doc.weixin.qq.com)壳:独立会话服务(wecomdoc,profile 与腾讯文档互不共享)/站点名/提取入口。
// opendoc 协议实现与腾讯文档共享(tencent-doc-protocol.js);企微特有差异(scode、MENTION_WXWORK 提及指令)已在协议层处理。
const { extractDoc, tencentHostForUrl } = require("./tencent-doc-protocol");

async function extractWecomDoc(url, { collectSessionCookies, fetchImpl } = {}) {
  return extractDoc(url, { sessionService: "wecomdoc", siteName: "企微文档", collectSessionCookies, fetchImpl });
}

module.exports = { extractWecomDoc, tencentHostForUrl };
