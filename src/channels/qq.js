"use strict";

const { BaseChannel } = require("./base");

// Obsidian 渲染进程的原生 fetch 受 CORS 限制(app://obsidian.md → QQ 端点无 ACAO 头,
// POST JSON 还触发 preflight,token/gateway 请求必被拦)。requestUrl 走 Electron net
// 通道无 CORS,包一层 Response-like 适配器供预检与 SDK(裸 fetch 引用全局,patch 生效)使用。
// 测试环境无 obsidian 模块,回退 globalThis.fetch。
function createCorsFreeFetch(requestUrl, fallback = globalThis.fetch) {
  if (!requestUrl) return fallback;
  return async function corsFreeFetch(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? input);
    const response = await requestUrl({
      url,
      method: init.method || "GET",
      headers: init.headers || undefined,
      body: init.body ?? undefined,
      throw: false,
    });
    const headerMap = new Map(Object.entries(response.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
    const text = () => String(response.text ?? "");
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
      text: async () => text(),
      json: async () => JSON.parse(text()),
      arrayBuffer: async () => response.arrayBuffer,
    };
  };
}

function loadRequestUrl() {
  try {
    return require("obsidian").requestUrl ?? null;
  } catch {
    return null;
  }
}

class QQChannel extends BaseChannel {
  constructor(config, context) {
    super("qq", config, context);
    this.bot = null;
    this._originalFetch = null;
    this._corsFreeFetch = null;
  }

  installFetch() {
    if (this._corsFreeFetch) return;
    this._corsFreeFetch = createCorsFreeFetch(loadRequestUrl());
    if (this._corsFreeFetch !== globalThis.fetch) {
      this._originalFetch = globalThis.fetch;
      globalThis.fetch = this._corsFreeFetch;
    }
  }

  restoreFetch() {
    if (this._corsFreeFetch && this._originalFetch && globalThis.fetch === this._corsFreeFetch) {
      globalThis.fetch = this._originalFetch;
    }
    this._corsFreeFetch = null;
    this._originalFetch = null;
  }

  async start() {
    this.assertFields(["appId", "appSecret"]);
    this.running = true;
    this.installFetch();
    const fetchImpl = this._corsFreeFetch;
    // 预检 token 端点连通性:区分「网络不可达/被拦」与「凭据错误」。
    // 网络层失败抛出友好提示;业务层响应(如 appid invalid)交由 SDK 正常处理。
    try {
      await fetchImpl("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: String(this.config.appId).trim(), clientSecret: String(this.config.appSecret).trim() }),
      });
    } catch (error) {
      this.restoreFetch();
      const reason = [error?.cause?.code, error?.cause?.message || error?.message || String(error)].filter(Boolean).join(" ");
      throw new Error(this.t(
        `无法访问 QQ 开放平台(bots.qq.com):${reason}。请检查网络后重试`,
        `Cannot reach the QQ Open Platform (bots.qq.com): ${reason}. Check your network and retry`,
      ));
    }
    const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
    // SDK 内部日志透传到 console:token/gateway 失败的底层原因(超时、DNS 等)不再被吞掉
    const logger = { debug() {}, info() {}, warn: (msg) => console.warn("[qq]", msg), error: (msg) => console.error("[qq]", msg) };
    const describeError = (error) => {
      const cause = error?.cause?.code || error?.cause?.message || "";
      return [error?.message || String(error), cause].filter(Boolean).join(" ← ");
    };
    this.bot = new QQBot({ appId: this.config.appId, appSecret: this.config.appSecret, logger, tokenPrefetch: "sync" });
    this.bot.on("ready", () => this.setState("connected", this.t("QQ Gateway 在线", "QQ Gateway online")));
    this.bot.on("resumed", () => this.setState("connected", this.t("QQ Gateway 已恢复", "QQ Gateway resumed")));
    this.bot.on("error", (error) => this.setState("error", describeError(error)));
    this.bot.on("message", async (_ctx, message) => {
      if (message.senderIsBot) return;
      await this.deliver({
        id: message.messageId,
        timestamp: new Date(message.timestamp),
        senderId: message.senderId,
        senderName: message.senderName || this.t("QQ 用户", "QQ user"),
        chatName: message.groupOpenid || message.channelId || this.t("QQ 私聊", "QQ direct message"),
        isGroup: ["group", "guild"].includes(message.kind),
        mentioned: Boolean(message.mentions?.length),
        text: message.content || "",
        attachments: (message.attachments || []).map((item) => ({
          fileName: item.filename || `qq-${message.messageId}`,
          mimeType: item.content_type || "application/octet-stream",
          url: item.voice_wav_url || item.url,
        })),
        reply: async (text) => this.bot.sendText(message.replyTarget, text),
        replyFile: async (file) => this.bot.sendFile(message.replyTarget, { buffer: file.buffer }, { fileName: file.name || "export.bin" }),
      });
    });
    this.setState("connecting", this.t("正在连接 QQ Gateway", "Connecting to QQ Gateway"));
    void this.bot.start().catch((error) => this.setState("error", describeError(error)));
  }

  async stop() {
    this.running = false;
    this.bot?.stop();
    this.bot = null;
    this.restoreFetch();
    this.setState("stopped");
  }
}

module.exports = { QQChannel, createCorsFreeFetch };
