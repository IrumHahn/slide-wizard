#!/usr/bin/env node
// inject-video-runtime.mjs — 덱에 발표용 영상 장치를 꽂는다(있으면 최신본으로).
//
//   보기만:  node scripts/inject-video-runtime.mjs
//   실제로:  node scripts/inject-video-runtime.mjs --write
//
// 평소엔 서버가 알아서 한다(덱을 열 때·저장할 때). 이건 한꺼번에 손보고 싶을 때.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureVideoRuntime, VIDEO_RUNTIME_VERSION } from "../lib/video-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECKS = join(ROOT, "decks");
const WRITE = process.argv.includes("--write");

const files = readdirSync(DECKS).filter((f) => f.endsWith(".html"));
if (!files.length) { console.log("덱이 없습니다:", DECKS); process.exit(0); }

console.log(`영상 장치 v${VIDEO_RUNTIME_VERSION} — 덱 ${files.length}개\n`);
let changed = 0;

for (const f of files) {
  const file = join(DECKS, f);
  const html = readFileSync(file, "utf8");
  const r = ensureVideoRuntime(html);
  if (!r.changed) { console.log(`  · ${f} — 이미 최신`); continue; }
  changed++;
  if (!WRITE) { console.log(`  ✎ ${f} — 꽂을 예정`); continue; }

  // 고치기 전 것은 .history 에 남긴다 — 편집기 저장과 같은 규칙
  const slug = f.replace(/\.html$/, "");
  const hist = join(DECKS, ".history", slug);
  mkdirSync(hist, { recursive: true });
  copyFileSync(file, join(hist, `${new Date().toISOString().replace(/[:.]/g, "-")}-pre-video.html`));
  writeFileSync(file, r.html, "utf8");
  console.log(`  ✓ ${f} — 꽂음`);
}

if (!changed) console.log("\n전부 최신입니다.");
else if (WRITE) console.log(`\n${changed}개 덱에 꽂았습니다. 되돌리려면 decks/.history/<덱>/ 의 -pre-video 파일.`);
else console.log(`\n${changed}개가 바뀝니다. 실제로 하려면 --write 를 붙이세요.`);

void existsSync;
