// jobs.mjs — Codex(또는 Claude Code)를 비동기로 부려 덱을 만든다.
//
// 왜 비동기 spawn 인가: spawnSync 는 응답이 올 때까지 서버 전체가 멈춘다.
// 전체 덱 생성은 몇 분짜리 작업이라, 잡으로 등록하고 UI 가 폴링한다.
//
// 검증 사다리: 배치 결과가 어휘를 벗어나면 → 수리 호출 1회 → 그래도 안 되면
// 정본 snippet 에 개요 텍스트를 부어 폴백. 잡 전체는 절대 실패하지 않는다 —
// 나쁜 배치는 "깨진 덱"이 아니라 "편집할 뼈대"로 강등된다.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SLIDE_CLASSES, SNIPPETS, assembleDeck, loadTemplate } from "./templates.mjs";
import { slugify } from "./deck-io.mjs";
import { setFolderMeta } from "./folders.mjs";
import { runAI, currentEngine, NO_ENGINE } from "./ai-engine.mjs";

const stripFence = (t) => t.replace(/^```(?:html|json)?\s*/m, "").replace(/```\s*$/m, "").trim();

// ───────────────────────── 단일 슬라이드 AI 수정 (기존 기능 이식)
export async function aiEditSlide(root, slug, slideHtml, instruction) {
  let classHint = "";
  const deckFile = slug ? join(root, "decks", `${slug}.html`) : null;
  if (deckFile && existsSync(deckFile)) {
    const html = readFileSync(deckFile, "utf8");
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    const classes = [...new Set([...styles.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
    classHint = `\n이미 정의된 class 만 쓰세요: ${classes.join(", ")}`;
  }
  const prompt = `당신은 HTML 슬라이드 편집자입니다.
이 조각은 <section class="slide">…</section> 하나의 내부(innerHTML)입니다:

\`\`\`html
${slideHtml}
\`\`\`

요청: ${instruction}

규칙:
1. 내부(innerHTML)만 다시 쓰세요. 설명·코드펜스 금지, 순수 HTML 만.
2. 새 class 를 만들지 마세요.${classHint}
3. 이미지 경로를 지어내지 마세요.
수정된 HTML 을 그대로 돌려주세요.`;
  const r = await runAI(prompt, { tier: "smart", timeoutMs: 180_000 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, html: stripFence(r.text) };
}

// ───────────────────────── 전체 덱 생성 잡
const jobs = new Map();

export function getJob(id) { return jobs.get(id); }

export function startGenerateJob(root, { title, topic, materials = "", templateId = "swiss-red", slideCount = 15, folder = "" }) {
  if (!title || !topic) throw new Error("title·topic 필요");
  if (!currentEngine()) throw new Error(NO_ENGINE);
  slideCount = Math.max(5, Math.min(30, Number(slideCount) || 15));
  const id = randomUUID().slice(0, 8);
  const job = {
    id, status: "running", phase: "개요 작성", detail: "", slug: null, error: null,
    startedAt: Date.now(),
    publicState() { return { id: this.id, status: this.status, phase: this.phase, detail: this.detail, slug: this.slug, error: this.error, elapsed: Math.round((Date.now() - this.startedAt) / 1000) }; },
  };
  jobs.set(id, job);
  run(job, root, { title, topic, materials, templateId, slideCount, folder })
    .catch((e) => { job.status = "error"; job.error = e.message; });
  return job;
}

async function run(job, root, { title, topic, materials, templateId, slideCount, folder }) {
  const t = loadTemplate(root, templateId);

  // 1) 개요 — 엄격 JSON, 유형은 어휘 enum 으로 제한
  const outlinePrompt = `발표 슬라이드 개요를 짭니다.

제목: ${title}
주제·요청: ${topic}
${materials ? `재료(참고자료):\n${materials.slice(0, 6000)}\n` : ""}
총 ${slideCount}장. 첫 장은 반드시 "slide--title", 마지막 장은 "slide--closing".
중간에 큰 단락이 바뀔 때 "slide--section" 을 넣으세요.

각 장을 이 JSON 배열로만 답하세요(설명 금지):
[{"cls":"<유형>","heading":"<제목 한 줄>","points":["<핵심 문장>", ...]}]

유형은 반드시 다음 중 하나: ${SLIDE_CLASSES.join(", ")}`;
  job.phase = "개요 작성"; job.detail = "";
  let outline = null, lastError = "";
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const r = await runAI(outlinePrompt, { timeoutMs: 240_000 });
    if (!r.ok) { lastError = r.error; continue; }
    try {
      const arr = JSON.parse(stripFence(r.text));
      if (Array.isArray(arr) && arr.length >= 3) {
        outline = arr.map((o) => ({
          cls: SLIDE_CLASSES.includes(o.cls) ? o.cls : "slide--list",
          heading: String(o.heading || "").slice(0, 120),
          points: (o.points || []).map(String).slice(0, 6),
        }));
      }
    } catch { /* 재시도 */ }
  }
  if (!outline) throw new Error(lastError || "개요 생성 실패 — 잠시 후 다시 시도해 주세요");

  // 2) 배치 생성 (5장씩)
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < outline.length; i += BATCH) batches.push(outline.slice(i, i + BATCH));
  const produced = [];

  for (let b = 0; b < batches.length; b++) {
    job.phase = `슬라이드 생성 ${b + 1}/${batches.length}`;
    job.detail = batches[b].map((o) => o.heading).join(" · ").slice(0, 80);
    const usedClasses = [...new Set(batches[b].map((o) => o.cls))];
    const fewshot = usedClasses.map((c) => `<!-- ${c} 예시 -->\n${SNIPPETS[c]}`).join("\n\n");
    const batchPrompt = `발표 슬라이드 HTML 을 만듭니다. 아래 예시의 구조와 class 만 사용하세요.

${fewshot}

색·글꼴은 class 가 알아서 입힙니다. style 속성·<style>·외부 URL·이미지 경로 발명 금지.
slide--image-full 의 .shot 은 이미지 없이 캡션만 두세요(나중에 사람이 넣습니다).

이번에 만들 슬라이드 (총 ${batches[b].length}장):
${JSON.stringify(batches[b], null, 1)}

전체 흐름 참고(제목만): ${outline.map((o, i) => `${i + 1}.${o.heading}`).join(" / ")}

각 장을 <section class="slide ..."> … </section> 으로, 순서대로, 설명 없이 HTML 만 답하세요.
한국어로, 문장은 짧고 단정하게. folio 는 ${b * BATCH + 1}부터 순번.`;

    let blocks = await generateBatch(batchPrompt);
    // 검증 사다리
    let bad = validateBlocks(blocks, batches[b].length);
    if (bad) {
      const repair = await generateBatch(batchPrompt + `\n\n주의: 이전 답이 규칙을 어겼습니다(${bad}). 규칙을 지켜 다시.`);
      if (!validateBlocks(repair, batches[b].length)) blocks = repair;
      else blocks = null;
    }
    if (!blocks) {
      // 폴백: snippet 에 개요 텍스트를 부어 뼈대라도 만든다
      blocks = batches[b].map((o) => fallbackSlide(o));
      job.detail += " (일부 뼈대로 대체)";
    }
    produced.push(...blocks);
  }

  // 3) 조립·저장
  job.phase = "조립"; job.detail = "";
  let slug = slugify(title); let n = 2;
  while (existsSync(join(root, "decks", `${slug}.html`))) slug = `${slugify(title)}-${n++}`;
  const html = setFolderMeta(assembleDeck(root, templateId, title, produced.join("\n\n")), folder);
  writeFileSync(join(root, "decks", `${slug}.html`), html, "utf8");
  job.slug = slug;
  job.status = "done"; job.phase = "완료";
}

async function generateBatch(prompt) {
  const r = await runAI(prompt, { timeoutMs: 300_000 });
  if (!r.ok) return null;
  const text = stripFence(r.text);
  const blocks = text.match(/<section class="slide[^"]*">[\s\S]*?<\/section>/g);
  return blocks || null;
}

/** 규칙 위반이면 사유 문자열, 통과면 null */
function validateBlocks(blocks, expected) {
  if (!blocks) return "출력 없음";
  if (blocks.length !== expected) return `장수 불일치(${blocks.length}/${expected})`;
  for (const blk of blocks) {
    const classes = [...blk.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    for (const c of classes.filter((c) => c.startsWith("slide--")))
      if (!SLIDE_CLASSES.includes(c)) return `모르는 유형 ${c}`;
    if (/<style|<script/i.test(blk)) return "style/script 포함";
    if (/src="https?:/i.test(blk)) return "외부 이미지";
  }
  return null;
}

function fallbackSlide(o) {
  const base = SNIPPETS[o.cls] || SNIPPETS["slide--list"];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let html = base.replace(/(<h2[^>]*>)[\s\S]*?(<\/h2>)/, `$1${esc(o.heading)}$2`)
    .replace(/(<h1[^>]*>)[\s\S]*?(<\/h1>)/, `$1${esc(o.heading)}$2`);
  if (o.points?.length && html.includes("<ul>")) {
    html = html.replace(/<ul>[\s\S]*?<\/ul>/, `<ul>\n${o.points.map((p) => `      <li>${esc(p)}</li>`).join("\n")}\n    </ul>`);
  }
  return html;
}
