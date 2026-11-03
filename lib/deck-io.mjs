// deck-io.mjs — 덱 파일 읽기/쓰기의 유일한 통로.
//
// 덱 1개 = 자체 완결 HTML. 이 모듈이 지키는 계약:
//  · 무대(<main class="deck-stage">) 안쪽만 교체한다 — 스크립트·스타일은 불변
//  · 저장 전엔 반드시 지문을 대조한다 (두 탭이 서로를 덮는 사고 방지)
//  · 저장마다 .history/ 에 이전본을 남긴다 (공짜 undo)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { extractFolder } from "./folders.mjs";

const STAGE_OPEN_RE = /<main class="deck-stage"[^>]*>/;
const STAGE_CLOSE = "</main>";

export function slugify(title) {
  const base = String(title).trim()
    .replace(/[\/\\:*?"<>|#%]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "deck";
  return base;
}

/** 파일 전체에서 무대 안쪽 HTML 과 그 경계를 찾는다. */
export function splitStage(html) {
  const open = html.match(STAGE_OPEN_RE);
  if (!open) throw new Error("무대(<main class=\"deck-stage\">)를 찾을 수 없습니다");
  const start = open.index + open[0].length;
  const end = html.indexOf(STAGE_CLOSE, start);
  if (end === -1) throw new Error("</main> 이 없습니다");
  return { before: html.slice(0, start), stage: html.slice(start, end), after: html.slice(end) };
}

/** 지문 = 이 파일 상태의 서명. 무대 내용이 조금이라도 바뀌면 달라진다. */
export function fingerprint(stageHtml) {
  return createHash("sha1").update(stageHtml).digest("hex").slice(0, 16);
}

export function slideCount(stageHtml) {
  return (stageHtml.match(/<section class="slide/g) || []).length;
}

export function extractTitle(html) {
  const m = html.match(/<title>(.*?)<\/title>/s);
  return m ? m[1].replace(/\s+/g, " ").trim() : "(제목 없음)";
}

/** 갤러리 썸네일 재료: 스타일 전문 + 첫 슬라이드 마크업. */
export function extractThumb(html) {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const { stage } = splitStage(html);
  const first = stage.match(/<section class="slide[^"]*"[^>]*>[\s\S]*?<\/section>/);
  return { css: styles, slide: first ? first[0] : "" };
}

export function readDeck(file) {
  const html = readFileSync(file, "utf8");
  const { stage } = splitStage(html);
  const st = statSync(file);
  return {
    slug: basename(file, ".html"),
    title: extractTitle(html),
    folder: extractFolder(html),
    slideCount: slideCount(stage),
    fingerprint: fingerprint(stage),
    mtime: st.mtimeMs,
    html,
    stageHtml: stage,
  };
}

/**
 * 무대 안쪽만 교체해 저장한다.
 * expectedFp 가 현재 파일과 다르면 저장하지 않고 conflict 를 알린다.
 */
export function writeStage(file, newStageHtml, expectedFp, historyDir) {
  const html = readFileSync(file, "utf8");
  const { before, stage, after } = splitStage(html);
  const currentFp = fingerprint(stage);
  if (expectedFp && expectedFp !== currentFp) {
    return { ok: false, conflict: true, fingerprint: currentFp };
  }
  if (historyDir) {
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, join(historyDir, `${ts}.html`));
    // 최근 30개만 유지
    const olds = readdirSync(historyDir).filter((f) => f.endsWith(".html")).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 30))) rmSync(join(historyDir, f));
  }
  writeFileSync(file, before + newStageHtml + after, "utf8");
  return { ok: true, fingerprint: fingerprint(newStageHtml) };
}

/** decks/ 폴더 목록. */
export function listDecks(decksDir) {
  if (!existsSync(decksDir)) return [];
  return readdirSync(decksDir)
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      try {
        const d = readDeck(join(decksDir, f));
        return { slug: d.slug, title: d.title, folder: d.folder, slideCount: d.slideCount, mtime: d.mtime, fingerprint: d.fingerprint };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}
