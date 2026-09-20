"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

function safeFileName(value, fallback = "item") {
  const cleaned = String(value || "").normalize("NFKC")
    // Strip replacement chars and lone surrogates (u flag keeps paired emoji
    // intact) so note file names can never trip the OS with EILSEQ on open.
    .replace(/[\uFFFD\uD800-\uDFFF]/gu, "")
    // macOS APFS rejects even some assigned code points (e.g. U+07BE, reached
    // via mojibake) with EILSEQ on open. Keep a name-friendly script allowlist
    // and turn everything else into spaces; body text keeps the original.
    .replace(/[^\u0020-\u007E\u00A1-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u2000-\u206F\u2600-\u27BF\u{1F000}-\u{1FAFF}]/gu, " ")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim().slice(0, 120);
  return cleaned || fallback;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function localDateParts(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const pad = (part, size = 2) => String(part).padStart(size, "0");
  const offset = -date.getTimezoneOffset();
  const offsetSign = offset >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offset);
  const offsetText = `${offsetSign}${pad(Math.floor(offsetAbs / 60))}:${pad(offsetAbs % 60)}`;
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    iso: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offsetText}`,
  };
}

function localIso(input = new Date()) {
  return localDateParts(input).iso;
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'）)\]]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;!?，。；！？]+$/, "")))];
}

function markdownEscape(value) {
  return String(value || "").replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  if (kind === 6) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd")
      || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  return false;
}

function assertSafeRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) links are supported");
  if (isPrivateHost(url.hostname)) throw new Error("Local and private network addresses are blocked");
  return url;
}

function encodeMultipart(fields = {}, files = []) {
  const boundary = `----odboundary${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"));
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${String(name).replace(/[\r\n"]/g, "")}"\r\n\r\n${String(value)}\r\n`);
  }
  for (const file of files) {
    const field = String(file.field || "file").replace(/[\r\n"]/g, "");
    const fileName = String(file.fileName || "file.bin").replace(/[\r\n"]/g, "_");
    const mimeType = file.mimeType || "application/octet-stream";
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    push(file.buffer || Buffer.alloc(0));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function exportMimeType(format, fileName = "") {
  const key = String(format || "").toLowerCase() || String(fileName || "").split(".").pop().toLowerCase();
  const map = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[key] || "application/octet-stream";
}

function mimeExtension(mime, fallback = "bin") {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "image/svg+xml": "svg", "image/avif": "avif", "application/pdf": "pdf",
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "video/mp4": "mp4", "text/plain": "txt",
  };
  return map[String(mime || "").split(";")[0].toLowerCase()] || fallback;
}

function toErrorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

module.exports = { assertSafeRemoteUrl, encodeMultipart, exportMimeType, extractUrls, isPrivateHost, localDateParts, localIso, markdownEscape, mimeExtension, safeFileName, shortHash, toErrorMessage, yamlString };
