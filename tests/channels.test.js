"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelManager } = require("../src/channels");

test("failed re-pairing restores an enabled channel and resumes its previous session", async () => {
  let saves = 0;
  let creates = 0;
  let resumed = false;
  const plugin = {
    settings: { channels: { wechat: { enabled: true, token: "existing-token" } } },
    saveSettings: async () => { saves += 1; },
    t: (zh) => zh,
  };
  const manager = new ChannelManager(plugin, async () => {});
  manager.create = () => {
    creates += 1;
    if (creates === 1) {
      return {
        beginPairing: async () => { throw new Error("pairing failed"); },
        stop: async () => {},
      };
    }
    return { start: async () => { resumed = true; } };
  };

  await assert.rejects(() => manager.pair("wechat", {}), /pairing failed/);
  assert.equal(plugin.settings.channels.wechat.enabled, true);
  assert.equal(resumed, true);
  assert.equal(manager.instances.has("wechat"), true);
  assert.equal(saves, 2);
});

test("failed first-time pairing remains disabled", async () => {
  const plugin = {
    settings: { channels: { wechat: { enabled: false, token: "" } } },
    saveSettings: async () => {},
    t: (zh) => zh,
  };
  const manager = new ChannelManager(plugin, async () => {});
  manager.create = () => ({
    beginPairing: async () => { throw new Error("pairing failed"); },
    stop: async () => {},
  });

  await assert.rejects(() => manager.pair("wechat", {}), /pairing failed/);
  assert.equal(plugin.settings.channels.wechat.enabled, false);
  assert.equal(manager.getStatuses().wechat.state, "error");
});

test("qq channel surfaces a friendly error when the open platform is unreachable", async () => {
  // 预检:token 端点网络层失败时给出可操作的提示(带底层原因),不再甩晦涩的 "Network error"
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  try {
    const { QQChannel } = require("../src/channels/qq");
    const channel = new QQChannel({ appId: "a", appSecret: "b" }, { t: (zh) => zh });
    await assert.rejects(() => channel.start(), /无法访问 QQ 开放平台\(bots\.qq\.com\):ENOTFOUND/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
