// 飞书文档专用提取:收敛 webclip 内飞书特有处理(渲染提取 + 会话 cookie 桥接)。
// 提取仍走浏览器会话渲染(不直连接口);正文图片下载依赖会话 cookie(imageHeaders 透传)。
async function extractFeishuDoc(url, { webSessionManager, collectSessionCookies, captureTimeoutMs } = {}) {
  const rendered = await webSessionManager.extract(url, "feishu", { captureTimeoutMs });
  // doc-info-time-item 文案形如"2023年11月3日创建",去掉尾部动词只留日期
  const publishedTime = typeof rendered.publishedTime === "string"
    ? rendered.publishedTime.replace(/\s*(创建|更新|编辑)$/, "").trim()
    : rendered.publishedTime;
  const normalized = publishedTime ? { ...rendered, publishedTime } : rendered;
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  return cookie ? { ...normalized, imageHeaders: { cookie } } : normalized;
}

module.exports = { extractFeishuDoc };
