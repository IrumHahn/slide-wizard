// templates.mjs — 템플릿(팔레트·폰트·추가 CSS)과 스켈레톤으로 덱을 찍어낸다.
//
// 어휘(슬라이드 유형 8종)는 모든 템플릿이 공유한다 — 템플릿은 "옷"만 바꾼다.
// 그래야 AI 생성 프롬프트도 템플릿과 무관하게 한 벌로 유지된다.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SLIDE_CLASSES = [
  "slide--title", "slide--section", "slide--two-col", "slide--big-stat",
  "slide--list", "slide--quote", "slide--image-full", "slide--closing",
];

/** 유형별 정본 예시 — 새 덱의 시작 슬라이드이자 AI 생성의 few-shot. */
export const SNIPPETS = {
  "slide--title": `<section class="slide slide--title">
  <div class="t-block"></div>
  <div class="t-eyebrow">부제 한 줄</div>
  <h1>발표 제목이<br><u>여기에</u> 들어갑니다</h1>
  <p class="t-sub">한 문장으로 오늘 이야기의 약속을 적습니다.</p>
  <div class="t-by">발표자 이름</div>
</section>`,
  "slide--section": `<section class="slide slide--section">
  <div class="kick">1부</div>
  <div class="num">01</div>
  <h2>장 제목</h2>
  <p class="note">이 장에서 다룰 내용을 한두 문장으로.</p>
  <div class="folio">02</div>
</section>`,
  "slide--two-col": `<section class="slide slide--two-col">
  <div class="pad">
    <div class="eyebrow">눈썹줄</div>
    <h2>두 칸으로 <u>비교</u>합니다</h2>
    <div class="head-rule"></div>
  </div>
  <div class="body">
    <div class="g2">
      <div class="card"><div class="tag">왼쪽</div><h3>제목</h3><p>내용</p></div>
      <div class="card accent"><div class="tag">오른쪽</div><h3>제목</h3><p>내용</p></div>
    </div>
  </div>
  <div class="folio">03</div>
</section>`,
  "slide--big-stat": `<section class="slide slide--big-stat">
  <div class="pad">
    <div class="eyebrow">눈썹줄</div>
    <h2>숫자로 <u>말합니다</u></h2>
    <div class="head-rule"></div>
  </div>
  <div class="body">
    <div class="g3">
      <div class="card stat"><b>30초</b><span>설명</span></div>
      <div class="card stat"><b>1,365</b><span>설명</span></div>
      <div class="card accent stat"><b>27개</b><span>설명</span></div>
    </div>
  </div>
  <div class="folio">04</div>
</section>`,
  "slide--list": `<section class="slide slide--list">
  <div class="pad">
    <div class="eyebrow">눈썹줄</div>
    <h2>핵심만 <u>추립니다</u></h2>
    <div class="head-rule"></div>
  </div>
  <div class="body">
    <ul>
      <li><span class="strong">첫 번째</span> — 설명을 붙입니다</li>
      <li><span class="strong">두 번째</span> — 설명을 붙입니다</li>
      <li><span class="strong">세 번째</span> — 설명을 붙입니다</li>
    </ul>
  </div>
  <div class="folio">05</div>
</section>`,
  "slide--quote": `<section class="slide slide--quote">
  <p class="q">"기억에 남을 문장을<br><u>크게</u> 놓습니다."</p>
  <div class="who">— 출처</div>
  <div class="folio">06</div>
</section>`,
  "slide--image-full": `<section class="slide slide--image-full">
  <div class="pad">
    <div class="eyebrow">눈썹줄</div>
    <h2>실물을 <u>보여줍니다</u></h2>
    <div class="head-rule"></div>
  </div>
  <div class="body" style="top:262px">
    <div class="shot"><div class="cap">캡션</div></div>
    <div class="aside"><p>이미지 옆에서 설명합니다.</p></div>
  </div>
  <div class="folio">07</div>
</section>`,
  "slide--closing": `<section class="slide slide--closing">
  <p class="statement">오늘 딱 하나만 남는다면,<br><u>이 문장</u>이길 바랍니다.</p>
  <p class="sub">고맙습니다 · 질문 받겠습니다</p>
  <div class="folio">08</div>
</section>`,
};

export function listTemplates(root) {
  const dir = join(root, "templates");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export function loadTemplate(root, id) {
  return JSON.parse(readFileSync(join(root, "templates", `${id}.json`), "utf8"));
}

function tokensCss(t) {
  const map = { ink: "--ink", paper: "--paper", accent: "--accent", accent2: "--accent2" };
  const lines = Object.entries(t.tokens).map(([k, v]) => `  ${map[k] || `--${k}`}:${v};`);
  if (t.fonts?.display) lines.push(`  --font-display:'${t.fonts.display}';`);
  if (t.fonts?.body) lines.push(`  --font-body:'${t.fonts.body}';`);
  return lines.join("\n");
}

/** 스켈레톤 + 템플릿 + 슬라이드 HTML → 자체 완결 덱 HTML */
export function assembleDeck(root, templateId, title, slidesHtml) {
  const t = loadTemplate(root, templateId);
  let html = readFileSync(join(root, "templates", "skeleton.html"), "utf8");
  html = html.replace("{{TITLE}}", title)
    .replace("{{TPL_ID}}", t.id)
    .replace("{{FONT_IMPORTS}}", (t.fonts?.cssImports || []).join("\n"))
    .replace("{{TOKENS_CSS}}", tokensCss(t))
    .replace("{{EXTRA_CSS}}", t.extraCss || "")
    .replace("{{SLIDES}}", slidesHtml);
  // 첫 슬라이드를 활성으로
  html = html.replace('<section class="slide ', '<section class="slide active visible ');
  return html;
}

/** 새 덱: 표지 + 장 구분 + 목록 3장으로 시작한다. */
export function createDeckFromTemplate(root, templateId, title) {
  const starter = [
    SNIPPETS["slide--title"].replace("발표 제목이<br><u>여기에</u> 들어갑니다", title),
    SNIPPETS["slide--section"],
    SNIPPETS["slide--list"],
  ].join("\n\n");
  return assembleDeck(root, templateId, title, starter);
}
