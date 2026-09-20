// 飞书文档专用提取:收敛 webclip 内飞书特有处理(渲染提取 + 会话 cookie 桥接)。
// 提取仍走浏览器会话渲染(不直连接口);正文图片下载依赖会话 cookie(imageHeaders 透传)。
async function extractFeishuDoc(url, { webSessionManager, collectSessionCookies, captureTimeoutMs } = {}) {
  const rendered = await webSessionManager.extract(url, "feishu", { captureTimeoutMs });
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  return cookie ? { ...rendered, imageHeaders: { cookie } } : rendered;
}

module.exports = { extractFeishuDoc };
