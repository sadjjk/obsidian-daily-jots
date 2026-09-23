"use strict";

// 抖音视频(v.douyin.com 短链 / douyin.com/video/{id} / iesdouyin share 页):
// 无 cookie 请求拿到的是降级壳(_ROUTER_DATA 只有请求上下文),门槛是
// 一个 ttwid cookie——而它由服务端在首次访问时 Set-Cookie 自动种下。
// 策略:两跳取数(第一跳领票,第二跳带票),数据在
// loaderData['video_(id)/page'].videoInfoRes.item_list[0]。
// 视频本体不下载,只留播放链接;话题按微博先例降噪为纯文本。

const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");

const DOUYIN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
// detail API 是桌面 webapp 端点,须配桌面 Chrome UA + douyin.com/video/{id} referer;移动 UA 会 403
const DOUYIN_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
// 2026-09-23 抓包+实测:该接口无需 a_bogus/msToken 签名与设备指纹(带 uifid 反而被 Argus 拦 403),
// cookie 只需 share 页自种的 ttwid 一个;裸 query 即可,多余参数已裁剪。
const DOUYIN_DETAIL_API = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const DOUYIN_DETAIL_QUERY = "device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500&version_name=19.5.0&cookie_enabled=true&screen_width=1600&screen_height=900&browser_language=zh-CN&browser_platform=MacIntel&browser_name=Chrome&browser_version=151.0.0.0&browser_online=true&os_name=Mac%20OS&os_version=10.15.7&platform=PC";

function douyinAwemeId(value) {
  const raw = String(value || "");
  const match = /\/(?:video|note)\/(\d+)/.exec(raw);
  if (match) return match[1];
  try {
    return new URL(raw).searchParams.get("aweme_id") || "";
  } catch (_) {
    return "";
  }
}

function isDouyinUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname;
    const isDouyinHost = host === "v.douyin.com" || host.endsWith(".douyin.com") || host.endsWith(".iesdouyin.com");
    return isDouyinHost && (Boolean(douyinAwemeId(value)) || host === "v.douyin.com");
  } catch (_) {
    return false;
  }
}

function cookieValue(cookieHeader, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(cookieHeader || ""))?.[1] || "";
}

function parseItem(html) {
  // 容忍 `};` 结尾(内联 script 常带分号),非贪婪回溯会吃掉嵌套 JSON 的中间括号。
  const match = /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
  if (!match) return null;
  try {
    const loader = JSON.parse(match[1])?.loaderData || {};
    const page = loader["video_(id)/page"] || Object.values(loader).find((v) => v && typeof v === "object" && (v.videoInfoRes || v.item_list)) || {};
    return page.videoInfoRes?.item_list?.[0] || page.item_list?.[0] || null;
  } catch (_) {
    return null;
  }
}

async function fetchDouyinPage(url, fetchImpl, cookie) {
  const { response, finalUrl } = await fetchImpl(String(url), {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers: { "user-agent": DOUYIN_UA, "accept-language": "zh-CN,zh;q=0.9", ...(cookie ? { cookie } : {}) },
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error(`Douyin page returned HTTP ${response.status}`);
  const html = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
  return { html, setCookie: response.headers?.get?.("set-cookie") || "", finalUrl: finalUrl || String(url) };
}

function formatDouyinTime(createTime) {
  const seconds = Number(createTime);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function douyinTitle(desc) {
  const firstLine = String(desc || "").split("\n")[0].trim();
  const stripped = firstLine.replace(/#\S+/g, "").replace(/\s{2,}/g, " ").trim();
  const base = stripped || firstLine || "抖音视频";
  return base.length > 40 ? `${base.slice(0, 40)}…` : base;
}

function douyinTextHtml(item) {
  const escaped = String(item?.desc || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.split(/\n{2,}/).map((para) => `<p>${para.trim().replace(/\n/g, "<br>")}</p>`).join("");
}

function douyinItemHtml(item) {
  const author = String(item?.author?.nickname || "抖音用户");
  const stats = [];
  if (Number(item?.statistics?.digg_count) > 0) stats.push(`赞 ${item.statistics.digg_count}`);
  if (Number(item?.statistics?.comment_count) > 0) stats.push(`评论 ${item.statistics.comment_count}`);
  if (Number(item?.statistics?.collect_count) > 0) stats.push(`收藏 ${item.statistics.collect_count}`);
  if (Number(item?.statistics?.share_count) > 0) stats.push(`转发 ${item.statistics.share_count}`);
  const parts = [formatDouyinTime(item?.create_time), ...stats];
  const meta = `<p class="douyin-item-meta">${parts.filter(Boolean).join(" · ")}</p>`;
  const cover = item?.video?.cover?.url_list?.find(Boolean) || item?.video?.dynamic_cover?.url_list?.find(Boolean) || "";
  const play = item?.video?.play_addr?.url_list?.find(Boolean);
  const playLink = play ? `<p class="douyin-item-video"><a href="${play}">视频</a></p>` : "";
  const coverUrl = cover ? (cover.startsWith("//") ? `https:${cover}` : cover) : "";
  const coverHtml = coverUrl ? `<p class="douyin-item-cover"><img src="${coverUrl}" alt="封面" /></p>` : "";
  return `<section class="douyin-item"><h3 class="douyin-item-author">${author}</h3>${meta}${douyinTextHtml(item)}${coverHtml}${playLink}</section>`;
}

// detail API:share 页 SSR 已无视频数据(2026-09 改版为纯客户端渲染),此接口是唯一数据源。
// cookie 仅需 ttwid(share 页自种);字段结构与原 item_list[0] 同族,douyinItemHtml 直接复用。
async function fetchDouyinDetail(awemeId, ttwid, fetchImpl) {
  const { response } = await fetchImpl(`${DOUYIN_DETAIL_API}?${DOUYIN_DETAIL_QUERY}&aweme_id=${encodeURIComponent(awemeId)}`, {
    accept: "application/json, text/plain, */*",
    headers: {
      "user-agent": DOUYIN_DESKTOP_UA,
      "accept-language": "zh-CN,zh;q=0.9",
      referer: `https://www.douyin.com/video/${awemeId}`,
      ...(ttwid ? { cookie: `ttwid=${ttwid}` } : {}),
    },
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error(`Douyin detail API returned HTTP ${response.status}`);
  const text = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
  let json; try { json = JSON.parse(text); } catch (_) { return null; }
  if (json.status_code !== 0 || !json.aweme_detail) return null;
  return json.aweme_detail;
}

async function extractDouyin(url, fetchImpl = globalThis.fetch) {
  // 第一跳:safeFetch 自动跟随短链 302 到落地页;从 finalUrl 解析 aweme_id。
  // 落地页响应正常会 Set-Cookie 种下 ttwid 访客票,但命中 CDN 缓存时不带——
  // 所以领票重试用裸 share 页(无 query,实测必种),失败再兜底一次。
  const first = await fetchDouyinPage(String(url), fetchImpl, "");
  let item = parseItem(first.html);
  const awemeId = String(douyinAwemeId(first.finalUrl) || douyinAwemeId(url) || item?.aweme_id || "");
  const shareUrl = awemeId ? `https://www.iesdouyin.com/share/video/${awemeId}/` : String(url);
  let ttwid = cookieValue(first.setCookie, "ttwid");
  if (!item) {
    if (!ttwid) {
      // 领票:请求裸 share 页收 Set-Cookie(不校验内容)。
      const seed = await fetchDouyinPage(shareUrl, fetchImpl, "");
      ttwid = cookieValue(seed.setCookie, "ttwid");
      item = item || parseItem(seed.html);
    }
    if (!item) {
      // 主路径:detail API(桌面端点 + ttwid)——share 页 SSR 已无数据,这里才有完整视频详情
      if (awemeId) item = await fetchDouyinDetail(awemeId, ttwid, fetchImpl);
      // 降级:share 页带票解析(历史路径,SSR 恢复时零成本命中)
      if (!item && ttwid) {
        const second = await fetchDouyinPage(shareUrl, fetchImpl, `ttwid=${ttwid}`);
        item = parseItem(second.html);
      }
    }
  }
  if (!item) {
    throw new Error(ttwid
      ? "Douyin returned no video data (detail API and share page both empty); the page may be rate-limited"
      : "Douyin did not issue a visitor ticket (ttwid) and no video data was found; retry once");
  }
  const author = String(item?.author?.nickname || "抖音用户");
  const cover = item?.video?.cover?.url_list?.find(Boolean) || item?.video?.dynamic_cover?.url_list?.find(Boolean) || "";
  const play = item?.video?.play_addr?.url_list?.find(Boolean) || "";
  const resolvedId = String(item?.aweme_id || awemeId || "");
  return {
    title: douyinTitle(item?.desc),
    byline: author,
    siteName: "www.douyin.com",
    contentHtml: `<article class="douyin-video">${douyinItemHtml(item)}</article>`,
    images: cover ? [cover.startsWith("//") ? `https:${cover}` : cover] : [],
    extractionMethod: "douyin",
    publishedAt: Number(item.create_time) > 0 ? localIso(new Date(Number(item.create_time) * 1000)) : "",
    url: String(url),
    canonicalUrl: resolvedId ? `https://www.douyin.com/video/${resolvedId}` : String(url),
    identityUrl: `douyin-video:${resolvedId}`,
    extractionStatus: "complete",
    videoUrl: play,
  };
}

module.exports = { DOUYIN_UA, DOUYIN_DESKTOP_UA, douyinAwemeId, douyinTitle, extractDouyin, fetchDouyinDetail, isDouyinUrl, parseItem };
