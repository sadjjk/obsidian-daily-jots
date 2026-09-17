#!/usr/bin/env node
// 剪藏迁移脚本 v3:
//   1) Clippings/<Family> 平铺 md → Clippings/<Family>/<日期>/,并补齐缺失的 platform 行;
//   2) Attachments/Web/<日期>/<子文件夹> 按尾部 hash 匹配 md,子文件夹改名为 md 文件名(去 .md),
//      子文件夹内 image-XX.<ext> → <标题段>-XX.<ext>;
//   3) 剪藏正文里的附件引用(原文与 encodeURI 两形态)同步替换;
//   4) Daily 双链按 hash 重写为当前实际路径(含日期层)。
//   默认 dry-run,--apply 才真改。
// 用法:
//   node scripts/migrate-source-names.mjs [--vault <路径>] [--apply]

import { readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const { sourceNameForUrl } = requireLocal(
  fileURLToPath(new URL("../src/core/source-names.js", import.meta.url)),
);

function parseArgs(argv) {
  const args = { apply: false, vault: "/Users/claw/Desktop/ObsidianProject" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--vault") args.vault = resolve(argv[++i] || "");
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function yamlSourcePath(content) {
  const match = content.match(/^source:\s*["']?(.+?)["']?\s*$/m);
  return match ? match[1].trim() : "";
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.*)-([0-9a-f]{8,16})\.md$/;

function ensurePlatform(content, label) {
  if (/^platform:/m.test(content)) return { content, changed: false };
  const line = `platform: "${label}"`;
  if (/^published_at:.*$/m.test(content)) {
    return { content: content.replace(/^published_at:.*$/m, (m0) => `${m0}\n${line}`), changed: true };
  }
  if (/^clipped_at:.*$/m.test(content)) {
    return { content: content.replace(/^clipped_at:.*$/m, (m0) => `${line}\n${m0}`), changed: true };
  }
  return { content, changed: false };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法: node scripts/migrate-source-names.mjs [--vault <路径>] [--apply]");
    return;
  }
  const data = JSON.parse(readFileSync(join(args.vault, ".obsidian/plugins/omnichannel-diary/data.json"), "utf8"));
  const settings = { capture: { sourceNameOverrides: data.capture?.sourceNameOverrides || {} } };
  const clippingRoot = join(args.vault, data.storage?.clippingFolder || "Omnichannel Diary/Clippings");
  const attachmentRoot = join(args.vault, data.storage?.attachmentFolder || "Attachments", "Web");
  const diaryDir = join(args.vault, data.storage?.diaryFolder || "Omnichannel Diary/Daily");
  const vaultRel = (abs) => abs.slice(args.vault.length + 1);
  const stats = { scanned: 0, moved: 0, platform: 0, renamed: 0, skipped: 0, links: 0 };
  const hashToNote = new Map();
  const attachmentOps = [];

  function noteLabel(content) {
    const explicit = content.match(/^platform:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    if (explicit) return explicit.trim();
    return sourceNameForUrl(yamlSourcePath(content), settings) || "普通网页";
  }

  // 阶段 1:md 日期分层 + platform 补齐;建立 hash → 新路径索引。
  for (const family of readdirSync(clippingRoot)) {
    const dir = join(clippingRoot, family);
    let entries;
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (_) {
      continue;
    }
    for (const name of entries) {
      const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})-/);
      if (!dateMatch) {
        stats.skipped += 1;
        continue;
      }
      stats.scanned += 1;
      const date = dateMatch[1];
      const targetDir = join(dir, date);
      const from = join(dir, name);
      const to = join(targetDir, name);
      let content = readFileSync(from, "utf8");
      const label = noteLabel(content);
      const platformResult = ensurePlatform(content, label);
      if (platformResult.changed) {
        stats.platform += 1;
        console.log(`${args.apply ? "补 platform" : "[dry-run] 将补 platform"}: ${family}/${name} -> ${label}`);
        content = platformResult.content;
      }
      const moved = from !== to;
      if (moved) {
        stats.moved += 1;
        console.log(`${args.apply ? "移动" : "[dry-run] 将移动"}: ${family}/${name} -> ${date}/${name}`);
      }
      if (args.apply && (moved || platformResult.changed)) {
        if (moved) mkdirSync(targetDir, { recursive: true });
        writeFileSync(to, content);
        if (moved) renameSync(from, to);
      }
      const hash = name.match(/-([0-9a-f]{8,16})\.md$/)?.[1];
      // apply 时文件已移到 to;dry-run 时仍读 from。
      if (hash) hashToNote.set(hash, { abs: to, readAbs: args.apply ? to : from, name });
    }
  }

  // 阶段 2:附件子文件夹改名(= md 文件名去 .md)+ 图片改名;收集引用替换对。
  const replacements = new Map();
  let webDates = [];
  try {
    webDates = readdirSync(attachmentRoot).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
  } catch (_) {
    console.log(`跳过(目录不存在): ${attachmentRoot}`);
  }
  for (const date of webDates) {
    const dateDir = join(attachmentRoot, date);
    for (const sub of readdirSync(dateDir)) {
      const subDir = join(dateDir, sub);
      const hash = sub.match(/-([0-9a-f]{8,16})$/)?.[1];
      const note = hash ? hashToNote.get(hash) : null;
      if (!note) {
        stats.skipped += 1;
        continue;
      }
      const noteName = note.name.replace(/\.md$/, "");
      if (sub === noteName) continue;
      const stem = noteName.match(FILENAME_RE)?.[2] || noteName;
      const newSubDir = join(dateDir, noteName);
      const files = readdirSync(subDir);
      const renamePairs = [];
      for (const file of files) {
        const imageMatch = file.match(/^image-(\d+)\.(.+)$/);
        if (!imageMatch) continue;
        const next = `${stem}-${imageMatch[1]}.${imageMatch[2]}`;
        renamePairs.push([file, next]);
        const oldRel = vaultRel(join(subDir, file));
        const newRel = vaultRel(join(newSubDir, next));
        replacements.set(oldRel, newRel);
        replacements.set(encodeURI(oldRel), encodeURI(newRel));
      }
      attachmentOps.push({ from: subDir, to: newSubDir, renamePairs });
      stats.renamed += 1;
      console.log(`${args.apply ? "改名" : "[dry-run] 将改名"}: Web/${date}/${sub} -> ${noteName}(含图片 ${renamePairs.length})`);
    }
  }

  // 阶段 3:剪藏正文里的附件引用替换(原文与 encodeURI 两形态)。
  for (const [, note] of hashToNote) {
    let content = readFileSync(note.readAbs, "utf8");
    let changed = 0;
    for (const [needle, replace] of replacements) {
      if (!content.includes(needle)) continue;
      changed += content.split(needle).length - 1;
      content = content.split(needle).join(replace);
    }
    if (changed > 0) {
      console.log(`${args.apply ? "更新引用" : "[dry-run] 将更新引用"}: ${vaultRel(note.abs)}(${changed} 处)`);
      if (args.apply) writeFileSync(note.abs, content);
    }
  }

  // 阶段 4:Daily 双链按 hash 重写(含日期层)。
  let diaryEntries = [];
  try {
    diaryEntries = readdirSync(diaryDir).filter((name) => name.endsWith(".md"));
  } catch (_) {}
  const LINK_RE = /\[\[(Omnichannel Diary\/Clippings\/[^\]|#]+?)-([0-9a-f]{8,16})([^\]]*)\]\]/g;
  for (const name of diaryEntries) {
    const path = join(diaryDir, name);
    const before = readFileSync(path, "utf8");
    let changed = 0;
    const after = before.replace(LINK_RE, (whole, _dirPath, hash, tail) => {
      const note = hashToNote.get(hash);
      if (!note) return whole;
      const expected = `[[${note.relNoExt}${tail}]]`;
      if (expected === whole) return whole;
      changed += 1;
      return expected;
    });
    if (changed > 0) {
      stats.links += changed;
      console.log(`${args.apply ? "更新双链" : "[dry-run] 将更新双链"}: Daily/${name}(${changed} 处)`);
      if (args.apply) writeFileSync(path, after);
    }
  }

  if (args.apply) {
    for (const { from, to, renamePairs } of attachmentOps) {
      for (const [file, next] of renamePairs) {
        renameSync(join(from, file), join(from, next));
      }
      renameSync(from, to);
    }
  }

  console.log(`\n扫描 ${stats.scanned} | 移动 ${stats.moved} | platform 补 ${stats.platform} | 附件文件夹改名 ${stats.renamed} | 跳过 ${stats.skipped} | 双链更新 ${stats.links}`);
  if (!args.apply) console.log("以上为 dry-run 预览;确认无误后追加 --apply 执行。");
}

main();
