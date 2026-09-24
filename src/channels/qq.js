"use strict";

const { BaseChannel } = require("./base");

class QQChannel extends BaseChannel {
  constructor(config, context) {
    super("qq", config, context);
    this.bot = null;
  }

  async start() {
    this.assertFields(["appId", "appSecret"]);
    this.running = true;
    // 预检 token 端点连通性:区分「网络/代理不可达」与「凭据错误」。
    // 网络层失败抛出友好提示;业务层响应(如 appid invalid)交由 SDK 正常处理。
    try {
      await fetch("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: String(this.config.appId).trim(), clientSecret: String(this.config.appSecret).trim() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = [error?.cause?.code, error?.cause?.message || error?.message || String(error)].filter(Boolean).join(" ");
      throw new Error(this.t(
        `无法访问 QQ 开放平台(bots.qq.com):${reason}。若系统开启了代理,请将 *.qq.com 加入直连规则或暂时关闭代理后重试`,
        `Cannot reach the QQ Open Platform (bots.qq.com): ${reason}. If a system proxy is on, add *.qq.com to its direct rules or turn it off and retry`,
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
    this.setState("stopped");
  }
}

module.exports = { QQChannel };
