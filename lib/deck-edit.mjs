// deck-edit.mjs — 「AI 수정 · 자료 조사」. 덱 한 장이 아니라 덱 전체를 고친다.
//
// 기존 aiEditSlide 와 뭐가 다른가:
//   · 도구가 켜진다      — Read·Grep·Glob 으로 config/ai-research.json 의 폴더를 실제로 읽는다.
//                          "OS 다시 보고 고쳐줘" 가 되는 지점이 여기다.
//   · 장을 늘리고 지운다 — innerHTML 한 덩어리가 아니라 {op, index, sections[]} 를 받아
//                          서버가 직접 splice 한다.
//   · 잡으로 돈다        — 조사가 붙으면 90초로는 안 끝난다. UI 는 /api/jobs/:id 를 폴링한다.
//
// 안전 장치(전부 서버 쪽에서 강제한다 — 모델의 선의에 기대지 않는다):
//   1. Claude Code 도구는 읽기 전용 3종, Codex 는 도구 없음. 쓰기·셸은 애초에 주지 않는다.
//   2. config/ai-research.json 의 deny 규칙으로 .env·토큰·개인 데이터를 막는다.
//   3. 모델이 돌려준 <section> 은 검문을 통과해야 한다 — script 금지, 없는 이미지 금지.
//   4. 파일은 모델이 아니라 이 모듈이 쓴다. 대상은 decks/<덱>.html 하나뿐.
//   5. 저장 전 .history 백업. 잘못돼도 되돌릴 수 있다.

import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { splitStage, fingerprint, writeStage } from "./deck-io.mjs";
import { currentEngine, NO_ENGINE, runAI } from "./ai-engine.mjs";

// Codex 는 도구가 꺼져 있어 파일을 못 연다. 덱 HTML 을 프롬프트에 그대로 싣는다.
const INLINE_DECK_LIMIT = 150_000;
const SECTION_RE = /<section class="slide[\s\S]*?<\/section>/g;

/* ───────────────────────── 조사 설정 */

/**
 * 조사 폴더와 차단 규칙을 읽어 온다.
 *
 * 차단 규칙을 왜 여기서 펼치는가 — Claude 의 권한 패턴에서 `**\/x` 는 "현재 작업 폴더 기준"
 * 이다. 조사 폴더는 --add-dir 로 따로 붙는 남의 폴더라 그 패턴이 걸리지 않는다.
 * 실제 검증에서 조사 폴더 안의 비밀 파일이 그대로 읽혔다.
 * 그래서 폴더마다 절대경로(`//<폴더>/**\/<패턴>`)로 규칙을 다시 만들어 붙인다.
 * 작업 폴더용 상대 규칙도 함께 남긴다.
 */
export function loadResearchConfig(root) {
  const empty = { dirs: [], deny: [], patterns: [], dirPatterns: [] };
  const f = join(root, "config", "ai-research.json");
  if (!existsSync(f)) return empty;

  let c;
  try { c = JSON.parse(readFileSync(f, "utf8")); } catch { return empty; }

  const dirs = (c.dirs || []).map((d) => resolve(d)).filter((d) => existsSync(d));
  const patterns = c.denyPatterns || [];
  const dirPatterns = c.denyDirs || [];

  const deny = [];
  // Read(경로) 하나가 파일을 읽는 모든 도구(Read·Grep·Glob)를 덮는다.
  // Grep(경로)·Glob(경로) 는 권한 검사 대상이 아니라 CLI 가 경고만 뱉는다.
  const add = (glob) => deny.push(`Read(${glob})`);

  // 1) 작업 폴더(발표자료 레포) 기준
  for (const p of patterns) { add(`**/${p}`); add(p); }
  for (const d of dirPatterns) add(`**/${d}/**`);

  // 2) 조사 폴더마다 절대경로 기준 — 이게 빠지면 위 규칙이 무용지물이다.
  //    절대경로 표기는 `//` + 맨 앞 / 를 뗀 경로다. dir 을 그대로 이으면 /// 가 되어 안 걸린다.
  for (const dir of dirs) {
    const abs = dir.replace(/^\/+/, "");
    for (const p of patterns) { add(`//${abs}/**/${p}`); add(`//${abs}/${p}`); }
    for (const d of dirPatterns) add(`//${abs}/**/${d}/**`);
  }

  // 훅이 쓸 실제 판정 재료. roots 안이 아니면 무조건 거부한다.
  const roots = [root, ...dirs];
  const allow = roots.map((d) => `Read(//${d.replace(/^\/+/, "")}/**)`);

  return {
    dirs, allow, patterns, dirPatterns,
    guard: {
      script: join(root, "lib", "research-guard.mjs"),
      roots, allow,
      denyNames: patterns,
      denyDirs: dirPatterns,
    },
  };
}

/* ───────────────────────── claude 호출 (도구 켜짐) */

// 통제는 permissions glob 이 아니라 PreToolUse 훅(research-guard.mjs)이 한다.
// 이유는 그 파일 맨 위에 적어 뒀다 — glob 매칭이 우리 의도와 달라 구멍이 났다.
// --permission-mode 는 주지 않는다(auto/bypass 는 훅 판정을 무의미하게 만든다).
function askAI(prompt, { cwd, addDirs = [], guard, timeoutMs = 600_000 } = {}) {
  const settings = {
    permissions: { allow: guard.allow },
    hooks: {
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: `node ${JSON.stringify(guard.script)}` }],
      }],
    },
  };
  return runAI(prompt, {
    tier: "smart", effort: "high", timeoutMs, cwd, addDirs, settings,
    tools: ["Read", "Grep", "Glob"],
    env: {
      GUARD_ALLOW_ROOTS: JSON.stringify(guard.roots),
      GUARD_DENY_NAMES: JSON.stringify(guard.denyNames),
      GUARD_DENY_DIRS: JSON.stringify(guard.denyDirs),
    },
  });
}

/* ───────────────────────── 덱 읽기 도우미 */

function sectionsOf(stageHtml) {
  return stageHtml.match(SECTION_RE) || [];
}

/** 무대를 [앞머리 · 슬라이드들 · 꼬리] 로 가른다.
 *  슬라이드만 골라 다시 이어 붙이면 <section> 밖에 있는 것이 전부 사라진다.
 *  편집기가 무대 안에 심어 두는 <style id="pe-layout-css"> (이미지 레이아웃 규칙)가
 *  그렇게 날아가면 이미지가 화면 전체로 퍼진다 — 2026-08-31 에 실제로 그랬다. */
function splitStageParts(stageHtml) {
  const sections = sectionsOf(stageHtml);
  if (!sections.length) return { head: "", sections, tail: "" };
  const first = stageHtml.indexOf(sections[0]);
  const last = sections[sections.length - 1];
  const end = stageHtml.lastIndexOf(last) + last.length;
  return { head: stageHtml.slice(0, first), sections, tail: stageHtml.slice(end) };
}

const textOf = (html, re) => {
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 70) : "";
};

/** 모델에게 줄 목차 — 몇 번 장이 무슨 장인지. */
function outlineOf(sections) {
  return sections.map((s, i) => {
    const kind = /class="slide sec"/.test(s) ? "장구분"
      : /class="slide active visible"/.test(s) && i === 0 ? "표지" : "본문";
    const eyebrow = textOf(s, /class="eyebrow[^"]*"[^>]*>([\s\S]*?)<\//) || textOf(s, /class="kick"[^>]*>([\s\S]*?)<\//);
    const head = textOf(s, /<h2[^>]*>([\s\S]*?)<\/h2>/) || textOf(s, /<h1[^>]*>([\s\S]*?)<\/h1>/);
    return `${i + 1}. [${kind}] ${eyebrow ? eyebrow + " — " : ""}${head}`;
  }).join("\n");
}

/** 프롬프트에 실을 덱 HTML. 너무 크면 번호를 붙인 앞부분만 싣고 그 사실을 적는다. */
function inlineDeckOf(sections) {
  let text = "", i = 0;
  for (; i < sections.length; i++) {
    const piece = `<!-- ${i + 1}번 장 -->\n${sections[i]}\n`;
    if (text.length + piece.length > INLINE_DECK_LIMIT) break;
    text += piece;
  }
  return i < sections.length ? `${text}<!-- ${i + 1}번 장부터는 분량 때문에 생략. 목차만 보고 판단하세요. -->` : text;
}

/** 덱이 실제로 정의한 class 목록 — 새 class 를 못 만들게 못 박는다. */
function classVocabulary(html) {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  // .slide--list .body 처럼 뒤에 다른 선택자가 오는 class 와, CSS 없이 표식으로만 쓰는 class 도 포함한다.
  const inCss = [...styles.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const inUse = [...splitStage(html).stage.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  return [...new Set([...inCss, ...inUse])];
}

/* ───────────────────────── 검문 */

/** 모델이 준 <section> 하나를 받아들일지 판단한다. 문제가 있으면 사유 문자열. */
function inspectSection(sec, { decksDir, vocabulary }) {
  if (!/^<section class="slide/.test(sec.trim())) return "<section class=\"slide\"> 로 시작하지 않음";
  if (!/<\/section>\s*$/.test(sec.trim())) return "</section> 으로 끝나지 않음";
  if ((sec.match(/<section/g) || []).length !== 1) return "section 이 겹쳐 있음";
  if (/<script|<style|on[a-z]+\s*=/i.test(sec)) return "script/style/인라인 이벤트 포함";
  if (/src="https?:/i.test(sec)) return "외부 이미지 주소";

  for (const m of sec.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    if (!existsSync(join(decksDir, m[1]))) return `없는 이미지 경로: ${m[1]}`;
  }
  const unknown = [...new Set([...sec.matchAll(/class="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((c) => c && !vocabulary.includes(c) && !/^d[1-8]$/.test(c)))];
  if (unknown.length) return `덱에 없는 class: ${unknown.slice(0, 5).join(", ")}`;
  return null;
}

/* ───────────────────────── 적용 */

/** 폴리오(쪽번호)를 슬라이드 순서대로 다시 매긴다. 장이 늘거나 줄면 반드시 돌려야 한다. */
function renumberFolios(sections) {
  return sections.map((s, i) =>
    s.replace(/<div class="folio">\s*\d+\s*<\/div>/, `<div class="folio">${i + 1}</div>`));
}

/** ops 를 슬라이드 배열에 적용한다. 인덱스가 밀리지 않게 뒤에서부터. */
function applyOps(sections, ops) {
  const list = [...sections];
  const applied = [];
  const sorted = [...ops].sort((a, b) => (b.index || 0) - (a.index || 0));
  for (const op of sorted) {
    const i = Number(op.index) - 1;          // 1-based → 0-based
    const secs = op.sections || [];
    if (op.op === "delete") {
      if (i < 0 || i >= list.length) throw new Error(`delete: ${op.index} 번 장이 없습니다`);
      list.splice(i, 1);
      applied.push(`${op.index}번 삭제`);
    } else if (op.op === "replace") {
      if (i < 0 || i >= list.length) throw new Error(`replace: ${op.index} 번 장이 없습니다`);
      if (!secs.length) throw new Error("replace 인데 sections 가 비었습니다");
      list.splice(i, 1, ...secs);
      applied.push(`${op.index}번 교체${secs.length > 1 ? ` (${secs.length}장으로)` : ""}`);
    } else if (op.op === "insertAfter" || op.op === "insertBefore") {
      const at = op.op === "insertAfter" ? i + 1 : i;
      if (at < 0 || at > list.length) throw new Error(`${op.op}: ${op.index} 번 위치가 없습니다`);
      if (!secs.length) throw new Error(`${op.op} 인데 sections 가 비었습니다`);
      list.splice(at, 0, ...secs);
      applied.push(`${op.index}번 ${op.op === "insertAfter" ? "뒤" : "앞"}에 ${secs.length}장 추가`);
    } else {
      throw new Error(`모르는 작업: ${op.op}`);
    }
  }
  return { list, applied: applied.reverse() };
}

/* ───────────────────────── 프롬프트 */

function buildPrompt({ deckPath, instruction, outline, inlineDeck, targetHtml, targetIndex, vocabulary, researchDirs }) {
  return `당신은 발표 슬라이드 덱을 고치는 편집자입니다. 파일은 당신이 쓰지 않습니다 — 고칠 내용만 JSON 으로 돌려주면 서버가 씁니다.

## 덱
${inlineDeck ? "" : `파일: ${deckPath} (Read 로 직접 열어 마크업을 확인해도 됩니다)\n`}총 ${outline.split("\n").length}장. 목차:
${outline}

${inlineDeck ? `## 덱 전체 HTML
\`\`\`html
${inlineDeck}
\`\`\`
` : ""}
${targetHtml ? `## 지금 보고 있는 장 (${targetIndex}번) 의 전체 HTML
\`\`\`html
${targetHtml}
\`\`\`
` : ""}
## 요청
${instruction}

## 자료 조사
${researchDirs.length
    ? `아래 폴더를 Read·Grep·Glob 으로 읽을 수 있습니다. 사실관계(숫자·이름·목록)를 쓸 때는 반드시 여기서 확인하고, 기억이나 추측으로 쓰지 마세요.
${researchDirs.map((d) => `  · ${d}`).join("\n")}
일부 파일은 열리지 않습니다(비밀 키·개인 데이터). 막히면 다른 근거를 찾고, 못 찾으면 그 항목은 손대지 마세요.`
    : "조사 폴더가 설정되어 있지 않습니다. 주어진 HTML 만 보고 고치세요."}

## 지켜야 할 것
1. 새 class 를 만들지 마세요. 이 덱이 정의한 class 만 씁니다:
${vocabulary.join(", ")}
2. 이미지 경로를 지어내지 마세요. 이미 덱에 있는 경로만 재사용합니다.
3. <script>, <style>, onclick 같은 인라인 이벤트를 넣지 마세요.
4. 슬라이드 한 장은 1920×1080 안에 들어가야 합니다. 표는 8행, 카드는 4개를 넘기지 마세요.
5. 쪽번호(<div class="folio">)는 아무 숫자나 넣어도 됩니다 — 서버가 다시 매깁니다.
6. 새로 만드는 장은 기존 장의 구조(.pad > .eyebrow + h2 + .head-rule, .body > 내용, .folio, .folio-l)를 그대로 따르세요.

## 답 형식
다른 말 없이 이 JSON 하나만 출력하세요. 코드펜스도 붙이지 마세요.

{
  "summary": "무엇을 왜 바꿨는지 두 문장 이내",
  "findings": ["조사해서 확인한 사실 (없으면 빈 배열)"],
  "ops": [
    { "op": "replace",     "index": 20, "sections": ["<section class=\\"slide\\">…</section>"] },
    { "op": "insertAfter", "index": 21, "sections": ["<section class=\\"slide\\">…</section>"] },
    { "op": "delete",      "index": 30 }
  ]
}

index 는 위 목차의 번호(1부터)입니다. 여러 장을 한 번에 넣으려면 sections 배열에 여러 개를 담으세요.
바꿀 게 없다면 ops 를 빈 배열로 두고 summary 에 이유를 쓰세요.`;
}

/* ───────────────────────── 잡 */

const jobs = new Map();
export function getDeckEditJob(id) { return jobs.get(id); }

export function startDeckEditJob(root, { slug, instruction, index = null }) {
  if (!slug || !instruction) throw new Error("slug·instruction 필요");
  const id = randomUUID().slice(0, 8);
  const job = {
    id, kind: "deck-edit", status: "running", phase: "덱 읽는 중", detail: "",
    slug, error: null, summary: "", findings: [], applied: [], slideCount: null,
    startedAt: Date.now(),
    publicState() {
      return {
        id: this.id, kind: this.kind, status: this.status, phase: this.phase, detail: this.detail,
        slug: this.slug, error: this.error, summary: this.summary, findings: this.findings,
        applied: this.applied, slideCount: this.slideCount,
        elapsed: Math.round((Date.now() - this.startedAt) / 1000),
      };
    },
  };
  jobs.set(id, job);
  run(job, root, { slug, instruction, index }).catch((e) => {
    job.status = "error";
    job.error = e.message;
  });
  return job;
}

async function run(job, root, { slug, instruction, index }) {
  const decksDir = join(root, "decks");
  const file = join(decksDir, `${slug}.html`);
  if (!existsSync(file)) throw new Error(`덱을 찾을 수 없습니다: ${slug}`);

  const html = readFileSync(file, "utf8");
  const { stage } = splitStage(html);
  const beforeFp = fingerprint(stage);
  const { head: stageHead, sections, tail: stageTail } = splitStageParts(stage);
  if (!sections.length) throw new Error("슬라이드를 찾을 수 없습니다");

  const vocabulary = classVocabulary(html);
  const engine = currentEngine();
  if (!engine) throw new Error(NO_ENGINE);
  const isCodex = engine.id === "codex";
  const { dirs: configDirs, guard } = loadResearchConfig(root);
  const dirs = isCodex ? [] : configDirs;   // Codex 는 읽기 범위를 막을 방법이 없어 조사 폴더를 열지 않는다
  const targetIndex = Number(index) > 0 ? Number(index) : null;
  const targetHtml = targetIndex && sections[targetIndex - 1] ? sections[targetIndex - 1] : null;

  job.phase = dirs.length ? "자료 조사 + 초안 작성" : "초안 작성";
  job.detail = dirs.length ? `조사 폴더 ${dirs.length}곳 · 몇 분 걸립니다` : "";

  const prompt = buildPrompt({
    deckPath: file, instruction, outline: outlineOf(sections),
    inlineDeck: isCodex ? inlineDeckOf(sections) : "",
    targetHtml, targetIndex, vocabulary, researchDirs: dirs,
  });

  // 작업 폴더를 빈 임시 디렉터리로 둔다. claude 는 작업 폴더의 '상위' 폴더까지 읽을 수 있어서,
  // 여기를 이 폴더로 잡으면 상위 폴더가 통째로 열린다. 정작 필요한 폴더는 전부 --add-dir 로 따로 붙인다.
  const workdir = mkdtempSync(join(tmpdir(), "deck-edit-"));
  let r;
  try {
    r = await askAI(prompt, { cwd: workdir, addDirs: [root, ...dirs], guard });
  } finally {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* 지워지지 않아도 무해 */ }
  }
  if (!r.ok) throw new Error(r.error);

  job.phase = "검문";
  let parsed;
  try {
    const t = r.text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    throw new Error("AI 응답을 JSON 으로 읽지 못했습니다. 요청을 조금 더 구체적으로 적어보세요.");
  }

  job.summary = String(parsed.summary || "").slice(0, 500);
  job.findings = (parsed.findings || []).map((s) => String(s).slice(0, 200)).slice(0, 10);

  const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  if (!ops.length) {
    job.status = "done";
    job.phase = "바뀐 것 없음";
    job.slideCount = sections.length;
    return;
  }

  for (const op of ops) {
    for (const sec of op.sections || []) {
      const bad = inspectSection(sec, { decksDir, vocabulary });
      if (bad) throw new Error(`검문에 걸렸습니다 — ${bad}`);
    }
  }

  job.phase = "저장";
  const { list, applied } = applyOps(sections, ops);
  if (!list.length) throw new Error("모든 장을 지우려 했습니다. 취소합니다.");

  const renumbered = renumberFolios(list);
  // 앞머리·꼬리를 그대로 돌려놓는다 — 여기에 편집기가 심은 레이아웃 CSS 가 산다
  const newStage = `${stageHead}${renumbered.join("\n\n")}${stageTail}`;
  const w = writeStage(file, newStage, beforeFp, join(decksDir, ".history", slug));
  if (!w.ok) throw new Error("저장하는 사이에 덱이 바뀌었습니다. 편집기를 새로고침하고 다시 시도하세요.");

  job.applied = applied;
  job.slideCount = renumbered.length;
  job.status = "done";
  job.phase = "완료";
}
