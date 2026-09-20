"use strict";

const { parseHTML } = require("linkedom");
const { readLimitedBody, safeFetch } = require("../../core/network");
const { localIso } = require("../../core/util");

const XHS_HTML_LIMIT = 5 * 1024 * 1024;

function hostMatches(hostname, suffix) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isXiaohongshuUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostMatches(hostname, "xiaohongshu.com")
      || hostMatches(hostname, "xhslink.com")
      || hostMatches(hostname, "xhslink.cn");
  } catch (_) { return false; }
}

function isXhsNoteUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostMatches(hostname, "xhslink.com") || hostMatches(hostname, "xhslink.cn")) return true;
    return hostMatches(hostname, "xiaohongshu.com")
      && /\/(?:explore|discovery\/item)\/[a-z0-9]+/i.test(url.pathname);
  } catch (_) { return false; }
}

const XHS_CHALLENGE_PATTERN = /安全验证|verify you are human|当前环境异常|请完成验证|访问受限/i;

function riskControlSignals(html) {
  const source = String(html || "");
  return {
    bytes: source.length,
    hasInitialState: /(?:window\.)?__INITIAL_STATE__\s*=/.test(source),
    challenge: XHS_CHALLENGE_PATTERN.test(source),
  };
}

function replaceBareUndefined(value) {
  const source = String(value || "");
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      index += 1;
      continue;
    }
    if (source.startsWith("undefined", index)) {
      const before = source[index - 1] || "";
      const after = source[index + 9] || "";
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        output += "null";
        index += 9;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function parseInitialState(html) {
  const { document } = parseHTML(String(html || ""));
  const script = [...document.querySelectorAll("script")]
    .find((candidate) => /(?:window\.)?__INITIAL_STATE__\s*=/.test(candidate.textContent || ""));
  if (!script) return null;
  const assignment = String(script.textContent || "")
    .replace(/^\s*(?:window\.)?__INITIAL_STATE__\s*=\s*/, "")
    .replace(/;\s*$/, "");
  if (!assignment || assignment.length > XHS_HTML_LIMIT) return null;
  try { return JSON.parse(replaceBareUndefined(assignment)); }
  catch (_) { return null; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function noteIdFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i);
    return match?.[1] || "";
  } catch (_) { return ""; }
}

function selectedNote(state, sourceUrl) {
  const noteState = state?.note || {};
  const map = noteState.noteDetailMap || {};
  const requestedId = noteIdFromUrl(sourceUrl) || String(noteState.currentNoteId || noteState.firstNoteId || "");
  const requested = map[requestedId];
  if (requested?.note) return requested.note;
  return Object.values(map).find((entry) => entry?.note)?.note || null;
}

function normalizedImageUrl(value) {
  try {
    const url = new URL(String(value || "").replace(/^http:/i, "https:"));
    if (url.protocol !== "https:" || !hostMatches(url.hostname, "xhscdn.com")) return "";
    return url.toString();
  } catch (_) { return ""; }
}

function noteImages(note) {
  const output = [];
  for (const image of note?.imageList || []) {
    const defaultVariant = (image.infoList || []).find((item) => item?.imageScene === "WB_DFT")?.url;
    const candidate = normalizedImageUrl(defaultVariant || image.urlDefault || image.urlPre || image.url);
    if (candidate && !output.includes(candidate)) output.push(candidate);
  }
  return output;
}

function publishedAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "" : localIso(date);
}

function xiaohongshuDataFromHtml(html, finalUrl) {
  if (!isXiaohongshuUrl(finalUrl)) return null;
  const state = parseInitialState(html);
  const note = selectedNote(state, finalUrl);
  if (!note?.noteId) return null;
  // 纯图笔记 title/desc 都为空是合法状态(作者未写文字),不能判为提取失败;
  // 标题退化为 "昵称 的图片笔记"。该笔记的全部内容即图片,提取齐图即视为完整。
  const byline = String(note.user?.nickname || "").trim();
  const title = String(note.title || note.desc || (byline ? `${byline} 的图片笔记` : "小红书笔记"))
    .replace(/\s+/g, " ").trim().slice(0, 160);
  const description = String(note.desc || "").trim();
  const images = noteImages(note);
  const body = escapeHtml(description).replace(/\r?\n/g, "<br>");
  const figures = images.map((url, index) => `<figure><img src="${escapeHtml(url)}" alt="小红书图片 ${index + 1}"></figure>`).join("");
  const canonicalUrl = `https://www.xiaohongshu.com/explore/${encodeURIComponent(note.noteId)}`;
  return {
    url: finalUrl,
    canonicalUrl,
    identityUrl: canonicalUrl,
    title,
    byline,
    excerpt: description.slice(0, 240),
    siteName: "小红书 / REDnote",
    contentHtml: `<article class="xiaohongshu-note"><h1>${escapeHtml(title)}</h1><p>${body}</p>${figures}</article>`,
    plainText: `${title}\n${description}`,
    images,
    publishedAt: publishedAt(note.time),
    extractionMethod: "xiaohongshu-initial-state",
    // 作者未写任何文字(纯图笔记),收据文案据此省略"正文"字样
    textless: !String(note.title || "").trim() && !description,
    extractionStatus: description.length >= 60 || images.length > 0 ? "complete" : "partial",
  };
}

async function extractXiaohongshu(value, fetchImpl = safeFetch) {
  if (!isXiaohongshuUrl(value)) return null;
  const fetchOptions = {
    accept: "text/html,application/xhtml+xml",
    headers: { "accept-language": "zh-CN,zh;q=0.9" },
    timeoutMs: 30_000,
  };
  let { response, finalUrl } = await fetchImpl(value, fetchOptions);
  if ([403, 429, 461].includes(response.status)) {
    // 小红书风控对裸请求偶发 403/461/429:短暂退避后带 referer 重试一次
    await new Promise((resolve) => setTimeout(resolve, 700));
    ({ response, finalUrl } = await fetchImpl(value, {
      ...fetchOptions,
      headers: { ...fetchOptions.headers, referer: "https://www.xiaohongshu.com/" },
    }));
  }
  if (!response.ok) throw new Error(`Xiaohongshu page returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    throw new Error(`Unsupported Xiaohongshu page type: ${contentType || "unknown"}`);
  }
  const html = (await readLimitedBody(response, XHS_HTML_LIMIT)).toString("utf8");
  const data = xiaohongshuDataFromHtml(html, finalUrl);
  if (!data && isXhsNoteUrl(finalUrl)) {
    const signals = riskControlSignals(html);
    throw new Error(
      `Xiaohongshu note extraction failed: no note data in page (HTTP ${response.status}, `
      + `${signals.bytes} bytes, initial-state ${signals.hasInitialState ? "present" : "missing"}, `
      + `${signals.challenge ? "risk-control challenge detected" : "no challenge marker"}). `
      + `Open the link in a browser or retry later.`,
    );
  }
  return data;
}

module.exports = {
  XHS_HTML_LIMIT,
  extractXiaohongshu,
  isXiaohongshuUrl,
  isXhsNoteUrl,
  noteImages,
  parseInitialState,
  replaceBareUndefined,
  xiaohongshuDataFromHtml,
};
