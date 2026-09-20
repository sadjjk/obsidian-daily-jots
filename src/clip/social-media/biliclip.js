"use strict";

// Bilibili video pages ship their full metadata in a `window.__INITIAL_STATE__`
// JSON assignment (title, description, uploader, publish date, stats, tags),
// but the generic readability path only sees a video-player shell and extracts
// nothing useful. This module extracts that structured state directly; when the
// site serves its probabilistic challenge shell instead, we retry and surface a
// real error rather than saving an empty note.

const { decodeHtmlBuffer, readLimitedBody, safeFetch } = require("../../core/network");
const { localIso } = require("../../core/util");

const STATE_MARKER = "window.__INITIAL_STATE__=";
const HTML_LIMIT = 5 * 1024 * 1024;

function hostMatches(value, hosts) {
  try { const hostname = new URL(String(value)).hostname.toLowerCase(); return hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`)); }
  catch (_) { return false; }
}

function isBilibiliUrl(value) {
  return hostMatches(value, ["bilibili.com", "b23.tv"]);
}

function isBilibiliVideoUrl(value) {
  const raw = String(value || "");
  if (!isBilibiliUrl(raw)) return false;
  if (hostMatches(raw, ["b23.tv"])) return true; // short links resolve to video pages
  return /\/video\/(?:BV|av|bv)[\w]+/i.test(raw);
}

// Pull a balanced `{...}` JSON object assigned to `marker`, tolerating braces
// inside strings and the `undefined` literals Bilibili ships in its state.
function jsonAssignmentFromHtml(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const braceStart = html.indexOf("{", start + marker.length);
  if (braceStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = braceStart; index < html.length; index += 1) {
    const ch = html[index];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(braceStart, index + 1).replace(/\bundefined\b/g, "null")); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}

function formatEpoch(seconds) {
  const ms = Number(seconds);
  if (!ms) return "";
  const date = new Date(ms * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeCoverUrl(pic) {
  const raw = String(pic || "");
  if (!raw) return "";
  if (/^https?:/i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  return "";
}

function videoFromInitialState(state, finalUrl) {
  const video = state?.videoData || {};
  const stat = video.stat || {};
  const owner = video.owner || {};
  const tags = (Array.isArray(state.tags) ? state.tags : []).map((tag) => tag?.tag_name).filter(Boolean);
  const desc = String(video.desc || "").trim();
  const published = formatEpoch(video.pubdate);
  const cover = normalizeCoverUrl(video.pic);
  const statsLine = [
    `播放 ${formatCount(stat.view)}`,
    `弹幕 ${formatCount(stat.danmaku)}`,
    `点赞 ${formatCount(stat.like)}`,
    `投币 ${formatCount(stat.coin)}`,
    `收藏 ${formatCount(stat.favorite)}`,
    `评论 ${formatCount(stat.reply)}`,
  ].join(" · ");
  const infoLines = [];
  if (owner.name) infoLines.push(`- UP 主:${owner.name}`);
  if (published) infoLines.push(`- 发布时间:${published}`);
  if (statsLine) infoLines.push(`- ${statsLine}`);
  const sections = [];
  if (desc) sections.push(`## 简介\n\n${desc}`);
  if (infoLines.length) sections.push(`## 视频信息\n\n${infoLines.join("\n")}`);
  if (tags.length) sections.push(`## 标签\n\n${tags.join(" · ")}`);
  const markdown = sections.join("\n\n");
  return {
    url: finalUrl,
    canonicalUrl: finalUrl,
    identityUrl: finalUrl,
    title: String(video.title || "").trim(),
    byline: String(owner.name || ""),
    excerpt: desc.slice(0, 240),
    siteName: "哔哩哔哩",
    markdown: markdown || desc,
    plainText: desc,
    images: cover ? [cover] : [],
    publishedAt: video.pubdate ? localIso(new Date(Number(video.pubdate) * 1000)) : "",
    extractionMethod: "bilibili-initial-state",
    extractionStatus: desc.length >= 40 ? "complete" : "partial",
  };
}

function metaContent(html, property) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

function videoFromDom(html, finalUrl) {
  const title = metaContent(html, "og:title")
    || (html.match(/<title[^>]*>([^<]{1,200})</i) || [])[1]?.trim()
    || "";
  const description = metaContent(html, "og:description")
    || metaContent(html, "description");
  const byline = (html.match(/up-name[^>]*>([^<]{1,60})</i) || html.match(/"owner":\s*\{[^}]*"name":"([^"]{1,60})"/) || [])[1] || "";
  // Challenge shells carry a bare <title> but no og data; treat them as missing.
  if (!title || !description) return null;
  const sections = [];
  if (description) sections.push(`## 简介\n\n${description}`);
  if (byline) sections.push(`## 视频信息\n\n- UP 主:${byline}`);
  return {
    url: finalUrl,
    canonicalUrl: finalUrl,
    identityUrl: finalUrl,
    title: title.trim(),
    byline,
    excerpt: String(description || "").slice(0, 240),
    siteName: "哔哩哔哩",
    markdown: sections.join("\n\n") || title,
    plainText: String(description || ""),
    images: [],
    publishedAt: "",
    extractionMethod: "bilibili-meta",
    extractionStatus: "partial",
  };
}

function bvidFromUrl(url) {
  const m = String(url || "").match(/\/video\/((?:BV|av)[\w]+)/i);
  return m ? m[1] : "";
}

// The public view API returns the same shape as videoData and does not require
// login; it bypasses the probabilistic challenge shells served on web pages.
async function fetchVideoViaApi(bvid, fetchImpl) {
  const api = /^av\d+$/i.test(bvid)
    ? `https://api.bilibili.com/x/web-interface/view?aid=${bvid.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const { response } = await fetchImpl(api, { accept: "application/json", timeoutMs: 20_000 });
  if (!response.ok) throw new Error(`Bilibili API returned HTTP ${response.status}`);
  const payload = JSON.parse((await readLimitedBody(response, 2 * 1024 * 1024)).toString("utf8"));
  if (payload?.code !== 0 || !payload?.data) throw new Error(`Bilibili API error ${payload?.code ?? "unknown"}`);
  return videoFromInitialState({ videoData: payload.data, tags: payload.data.tags || [] }, `https://www.bilibili.com/video/${bvid}`);
}

async function extractBilibili(value, fetchImpl = safeFetch) {
  const url = String(value || "");
  if (!isBilibiliUrl(url)) return null;
  let lastError;
  let lastFinalUrl = url;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const { response, finalUrl } = await fetchImpl(url, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        timeoutMs: 30_000,
      });
      if (!response.ok) throw new Error(`Bilibili returned HTTP ${response.status}`);
      lastFinalUrl = finalUrl;
      const contentType = response.headers.get("content-type") || "";
      const html = decodeHtmlBuffer(await readLimitedBody(response, HTML_LIMIT), contentType);
      const target = isBilibiliVideoUrl(finalUrl) ? finalUrl : url;
      if (!isBilibiliVideoUrl(target)) return null; // short link to a non-video page: generic path
      const state = jsonAssignmentFromHtml(html, STATE_MARKER);
      if (state?.videoData?.title) return videoFromInitialState(state, target);
      const dom = videoFromDom(html, target);
      if (dom) return dom;
      lastError = new Error("Bilibili served a challenge page without video data");
    } catch (error) { lastError = error; }
  }
  // Web page keeps hitting the challenge shell: fall back to the public view API.
  const bvid = bvidFromUrl(url) || bvidFromUrl(lastFinalUrl);
  if (bvid) {
    try { return await fetchVideoViaApi(bvid, fetchImpl); } catch (error) { lastError = lastError || error; }
  }
  throw lastError || new Error("Bilibili extraction failed");
}

module.exports = { extractBilibili, formatCount, isBilibiliUrl, isBilibiliVideoUrl, jsonAssignmentFromHtml, videoFromDom, videoFromInitialState };
