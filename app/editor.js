/* 편집기 — 덱을 iframe 으로 열어 DOM 을 직접 만진다.
 *
 * 지키는 것:
 *  · 저장은 무대 안쪽만, cleanForSave() 로 편집 흔적을 전부 벗긴 뒤에
 *  · 엔터는 <br>, 붙여넣기는 평문 (문단 쪼개짐 사고 재발 방지)
 *  · 글자 서식은 Range 래핑, 선택이 한 블록을 벗어나면 적용하지 않는다
 *  · 이미지는 자유 배치가 아니라 레이아웃 슬롯(.pe-slot)에만 앉는다 — 위치·크기는 슬라이드가 정한다
 */
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show");
  clearTimeout(window.__tt); window.__tt = setTimeout(() => t.classList.remove("show"), 2600); };

const slug = new URLSearchParams(location.search).get("deck");
if (!slug) location.href = "/";

const frame = $("#frame");
let doc = null;
let fp = null;
let dirty = false;
let saveTimer = null;
let current = 0;
let templates = [];
let myTemplate = null;

const TEXT_BLOCKS = "h1,h2,h3,h4,p,li,td,th,figcaption,blockquote";
const EXTRA_TEXT = ".eyebrow,.tag,.cap,.folio,.lede,.statement,.q,.note,.t-sub,.t-by,.t-eyebrow,.kick,.who,.big,.stat b,.stat span,.out,.w,.arrow-d,.attrib,.prac,.prac-sub,.prac-min,.pill,.pe-cap";

/* ───────────────────────── 부팅 */
init();
async function init() {
  const meta = await (await fetch(`/api/decks/${encodeURIComponent(slug)}`)).json();
  if (meta.error) { toast(meta.error); return; }
  fp = meta.fingerprint;
  $("#deckTitle").value = meta.title;
  templates = await (await fetch("/api/templates")).json();
  frame.src = `/decks/${encodeURIComponent(slug)}.html`;
  frame.addEventListener("load", boot, { once: true });
  fitFrame();
  addEventListener("resize", fitFrame);
}

function fitFrame() {
  const box = $("#main").getBoundingClientRect();
  const pad = 36;
  const f = Math.min((box.width - pad) / 1920, (box.height - pad) / 1080);
  frame.style.width = `${1920 * f}px`;
  frame.style.height = `${1080 * f}px`;
}

function boot() {
  doc = frame.contentDocument;
  doc.defaultView.__DECK_EDIT_MODE = true;

  // 덱에 내장된 옛 편집 단축키(e/a — 강의 덱)가 끼어들지 못하게 캡처 단계에서 차단
  doc.addEventListener("keydown", (e) => {
    if (!e.target.isContentEditable && !e.metaKey && !e.ctrlKey &&
        ["e", "E", "a", "A"].includes(e.key)) e.stopImmediatePropagation();
  }, true);

  const kill = doc.createElement("style");
  kill.className = "pe-ui";
  kill.textContent = `.editbar,.ai-panel,.toast,.progress{display:none!important}
    .reveal{opacity:1!important;transform:none!important;transition:none!important}
    [contenteditable="true"]{outline:none}
    [contenteditable="true"]:hover{outline:1px dashed rgba(225,54,28,.4);outline-offset:2px}
    [contenteditable="true"]:focus{outline:2px solid #E1361C;outline-offset:2px}
    .pe-picked{outline:2px solid #E1361C!important;outline-offset:2px}
    .pe-seltb{position:fixed;z-index:99999;background:#14150F;border-radius:9px;padding:5px 6px;display:none;gap:2px;box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:'Pretendard',sans-serif}
    .pe-seltb button{border:0;background:transparent;color:#F5F2EB;font-size:14px;font-weight:600;padding:6px 9px;border-radius:6px;cursor:pointer;font-family:inherit}
    .pe-seltb button:hover{background:rgba(255,255,255,.16)}
    .pe-seltb .sw{width:16px;height:16px;border-radius:4px;display:inline-block;vertical-align:-2px;border:1px solid rgba(255,255,255,.3)}
    .pe-slidetb{position:fixed;z-index:99998;right:14px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;font-family:'Pretendard',sans-serif}
    .pe-slidetb button{border:0;border-radius:8px;background:rgba(20,21,15,.82);color:#F5F2EB;font-size:13px;padding:9px 11px;cursor:pointer;font-family:inherit;white-space:nowrap}
    .pe-slidetb button:hover{background:#E1361C}
    .pe-vbar{display:none!important}`;
  doc.head.appendChild(kill);

  buildSlideToolbar();
  buildBlockToolbar();
  buildSelToolbar();
  buildFmtBar();
  buildThemeSelect();
  enableEditing();
  ensureLayoutCss();
  buildVideoToolbar();
  enableImagePick();
  rehydrateSlots();
  paintVideoBadges();
  doc.defaultView.__peStopAll?.();          // 편집 중에 영상이 저 혼자 돌지 않게
  buildRail();
  show(0);

  // 덱 자체 네비게이션(화살표·클릭)으로 장이 넘어가도 레일이 따라오게 한다
  doc.addEventListener("keyup", () => curSlide());
  doc.addEventListener("click", () => curSlide());

  // 넘김 키·휠은 편집기가 직접 받는다 — 덱에 내장된 네비게이션은 제 current 를 따로 들고 있어,
  // 목차로 8장에 간 뒤 ↓를 누르면 옛 장 기준(3→4)으로 튀던 원인. 캡처 단계에서 가로채 덱까지 안 보낸다.
  doc.addEventListener("keydown", (e) => {
    if (e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
    const fwd = ["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key);
    const back = ["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key);
    if (!fwd && !back && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === "Home") show(0);
    else if (e.key === "End") show(slides().length - 1);
    else show(current + (fwd ? 1 : -1));
  }, true);
  let wheelLock = false;
  doc.addEventListener("wheel", (e) => {
    e.stopImmediatePropagation();             // 덱의 휠 넘김도 같은 이유로 어긋난다 — 항상 차단
    if (e.target.isContentEditable) return;
    if (wheelLock || Math.abs(e.deltaY) < 24) return;
    wheelLock = true; setTimeout(() => { wheelLock = false; }, 620);
    show(current + (e.deltaY > 0 ? 1 : -1));
  }, { capture: true, passive: true });

  const mo = new MutationObserver((muts) => {
    if (muts.every((m) => m.target.closest && m.target.closest(".pe-ui,.pe-seltb,.pe-slidetb,.pe-imgtb,.pe-vbar"))) return;
    markDirty();
  });
  mo.observe(stage(), { subtree: true, childList: true, characterData: true, attributes: true });

  stage().addEventListener("beforeinput", snapSoon);

  const onKey = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "s") { e.preventDefault(); save(); return; }
    if (e.key.toLowerCase() !== "z") return;
    // 글자를 치는 중이면 브라우저 기본 undo 에 맡긴다 — 한 글자씩 되돌아가는 게 자연스럽다
    if (e.target.isContentEditable && !e.shiftKey) return;
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  };
  doc.addEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  paintUndo();
}

const stage = () => doc.getElementById("deckStage") || doc.querySelector(".deck-stage");
const slides = () => [...stage().querySelectorAll(".slide")];

/* 지금 보고 있는 장은 DOM 이 정답이다.
 * 덱마다 제 키보드 네비게이션이 살아 있어서 화살표로 넘기면 current 만 뒤처진다.
 * (이미지가 엉뚱하게 1번 장에 꽂히던 원인이 이것이었다.) */
function curSlide() {
  const list = slides();
  const active = stage().querySelector(".slide.active") || stage().querySelector(".slide.visible");
  const i = active ? list.indexOf(active) : -1;
  if (i >= 0 && i !== current) { current = i; paintRailOn(); }
  return list[current] || list[0];
}
function paintRailOn() {
  [...$("#rail").children].forEach((el, k) => el.classList.toggle("on", k === current));
}

/* ───────────────────────── 레일·이동 */
function buildRail() {
  const rail = $("#rail"); rail.innerHTML = "";
  slides().forEach((s, i) => {
    const h = s.querySelector("h1,h2,h3");
    const label = (h ? h.textContent : s.textContent).replace(/\s+/g, " ").trim().slice(0, 34) || "(빈 슬라이드)";
    const el = document.createElement("div");
    el.className = "sl" + (i === current ? " on" : "");
    el.draggable = true;
    el.dataset.i = i;
    el.title = "끌어서 순서를 바꿉니다";
    el.innerHTML = `<span class="n">${i + 1}</span><span>${label}</span>`;
    // 드래그가 끝나며 딸려 오는 click 으로 엉뚱한 장이 열리지 않게 막는다
    el.onclick = () => { if (!railDragged) show(i); };
    rail.appendChild(el);
  });
  bindRailDnd();
}

/* ───────────────────────── 목차 끌어서 순서 바꾸기
 * 리스너는 #rail 하나에 건다 — buildRail 이 자식을 통째로 갈아끼우기 때문에
 * 항목마다 걸면 정렬할 때마다 리스너가 사라진다. */
let railFrom = -1;      // 끌기 시작한 슬라이드 번호
let railDragged = false; // 이번 마우스 동작이 '끌기' 였나 (클릭과 구분)

function bindRailDnd() {
  const rail = $("#rail");
  if (rail.dataset.dnd) return;
  rail.dataset.dnd = "1";

  const clearMarks = () =>
    rail.querySelectorAll(".sl").forEach((e) => e.classList.remove("drop-before", "drop-after"));

  // 매 조작 시작마다 상태를 리셋한다. dragend 에만 기대면 안 된다 —
  // 놓는 순간 buildRail 이 끌던 항목을 DOM 에서 없애버려서 dragend 가 오지 않고,
  // railDragged 가 켜진 채 남아 그 뒤 클릭이 전부 죽는다(실제로 그랬다).
  rail.addEventListener("mousedown", () => { railDragged = false; });

  // 놓을 자리 = 가리키는 항목의 위쪽 절반이면 그 앞, 아래쪽 절반이면 그 뒤.
  const dropTarget = (e) => {
    const el = e.target.closest(".sl");
    if (!el) return { el: null, to: slides().length };   // 빈 곳에 놓으면 맨 끝
    const r = el.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    return { el, before, to: Number(el.dataset.i) + (before ? 0 : 1) };
  };

  rail.addEventListener("dragstart", (e) => {
    const el = e.target.closest(".sl");
    if (!el) return;
    railFrom = Number(el.dataset.i);
    railDragged = false;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(railFrom)); } catch { /* 파이어폭스 대비 */ }
  });

  rail.addEventListener("dragover", (e) => {
    if (railFrom < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    railDragged = true;
    const { el, before } = dropTarget(e);
    clearMarks();
    if (el) el.classList.add(before ? "drop-before" : "drop-after");
  });

  rail.addEventListener("drop", (e) => {
    if (railFrom < 0) return;
    e.preventDefault();
    const { to } = dropTarget(e);
    clearMarks();
    moveSlideTo(railFrom, to);
    railFrom = -1;
    // 놓은 직후 따라오는 click 만 막고, 그 뒤로는 다시 클릭이 살아나야 한다
    setTimeout(() => { railDragged = false; }, 0);
  });

  rail.addEventListener("dragend", () => {
    clearMarks();
    rail.querySelectorAll(".dragging").forEach((e) => e.classList.remove("dragging"));
    railFrom = -1;
    // click 은 dragend 뒤에 온다. 한 박자 뒤에 풀어야 클릭을 제대로 막는다.
    setTimeout(() => { railDragged = false; }, 0);
  });
}

/** 쪽번호(.folio)를 슬라이드 순서대로 다시 매긴다.
 *  장을 옮기거나 복제·삭제하면 번호가 어긋난 채로 저장되고 PDF 에 그대로 나간다.
 *  자리 수는 원래 쓰던 표기를 지킨다 — "03" 이었으면 "12", "3" 이었으면 "12". */
function renumberFolios() {
  slides().forEach((s, i) => {
    const f = s.querySelector(".folio");
    if (!f) return;                        // 표지처럼 번호가 없는 장은 건드리지 않는다
    const cur = f.textContent.trim();
    if (!/^\d+$/.test(cur)) return;        // 숫자가 아니면 사람이 손으로 쓴 것 — 그대로 둔다
    f.textContent = String(i + 1).padStart(cur.length, "0");
  });
}

/** from 번 슬라이드를 to 번 '자리'로 옮긴다. to 는 옮기기 전 기준의 삽입 위치다. */
function moveSlideTo(from, to) {
  const list = slides();
  if (from < 0 || from >= list.length) return;
  if (to > from) to--;                    // 자기 자신이 빠지면 뒤쪽 자리가 하나 당겨진다
  if (to === from || to < 0) return;

  const node = list[from];
  node.remove();
  const rest = slides();                  // from 이 빠진 목록
  if (to >= rest.length) rest[rest.length - 1].after(node);
  else rest[to].before(node);

  renumberFolios();
  buildRail();
  show(to);
  markDirty();
  toast(`${from + 1}번 → ${to + 1}번으로 옮겼습니다`);
}

function show(i) {
  const list = slides();
  if (i < 0 || i >= list.length) return;
  current = i;
  list.forEach((s, k) => { s.classList.toggle("active", k === i); s.classList.toggle("visible", k === i); });
  paintRailOn();
  hideSelTb(); unpickImage(); hideBlockTb();
}

/* ───────────────────────── 편집 활성 + 가드 */
function enableEditing() {
  for (const el of stage().querySelectorAll(TEXT_BLOCKS + "," + EXTRA_TEXT)) {
    if (el.closest(".pe-ui")) continue;
    if (el.querySelector("img,section,main")) continue;
    el.setAttribute("contenteditable", "true");
  }
  if (stage().dataset.peGuards) return;
  stage().dataset.peGuards = "1";
  stage().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.isContentEditable) { e.preventDefault(); doc.execCommand("insertLineBreak"); }
  });
  stage().addEventListener("paste", (e) => {
    if (!e.target.isContentEditable) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    doc.execCommand("insertText", false, text.replace(/\r?\n/g, " "));
  });
}

/* ───────────────────────── 슬라이드 툴바 */
function buildSlideToolbar() {
  const tb = doc.createElement("div");
  tb.className = "pe-slidetb pe-ui";
  tb.innerHTML = `
    <button data-a="add">＋ 새 장</button>
    <button data-a="up">↑ 이동</button>
    <button data-a="down">↓ 이동</button>
    <button data-a="dup">⧉ 복제</button>
    <button data-a="text">＋ 텍스트</button>
    <button data-a="img">🖼 이미지</button>
    <button data-a="vid">🎬 영상</button>
    <button data-a="del">🗑 삭제</button>`;
  doc.body.appendChild(tb);
  tb.addEventListener("click", (e) => {
    const a = e.target.dataset?.a; if (!a) return;
    if (a !== "img" && a !== "vid") snap();                    // 이미지·영상은 배치를 고른 뒤에 쌓는다
    const s = curSlide();
    const list = slides();
    if (a === "del") {
      if (list.length <= 1) return toast("마지막 슬라이드는 지울 수 없습니다");
      if (!confirm(`${current + 1}번 슬라이드를 삭제할까요?`)) return;
      s.remove(); renumberFolios(); show(Math.min(current, slides().length - 1)); buildRail(); markDirty();
    }
    if (a === "dup") {
      const c = s.cloneNode(true); c.classList.remove("active", "visible");
      s.after(c); renumberFolios(); buildRail(); show(current + 1); markDirty();
    }
    if (a === "up" && current > 0) { list[current - 1].before(s); renumberFolios(); buildRail(); show(current - 1); markDirty(); }
    if (a === "down" && current < list.length - 1) { list[current + 1].after(s); renumberFolios(); buildRail(); show(current + 1); markDirty(); }
    if (a === "text") {
      const p = doc.createElement("p");
      p.textContent = "새 텍스트 — 눌러서 고치세요";
      p.style.cssText = "position:absolute;left:96px;top:880px;font-size:27px;font-weight:300;max-width:1500px;margin:0";
      p.setAttribute("contenteditable", "true");
      s.appendChild(p); markDirty();
    }
    if (a === "img") openImgPane();
    if (a === "vid") openVidPane();
    if (a === "add") openNewPane();
  });
}

/* ───────────────────────── 텍스트 블럭 복제·삭제
 *
 * 블럭(문단·불릿 항목·제목 등)을 눌러 편집에 들어가면 그 블럭 위에
 * 작은 도구가 뜬다. 복제는 바로 뒤에 같은 블럭을 하나 더, 삭제는 블럭째 지운다.
 * 글자 선택 툴바(.pe-seltb)와 겹치지 않게 블럭의 오른쪽 위에 붙인다.
 */
let blockEl = null, blockTb = null;

function buildBlockToolbar() {
  const st = doc.createElement("style");
  st.className = "pe-ui";
  st.textContent = `
    .pe-blocktb{position:fixed;z-index:99997;background:#14150F;border-radius:8px;padding:4px 5px;display:none;gap:2px;
      box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:'Pretendard',sans-serif}
    .pe-blocktb button{border:0;background:transparent;color:#F5F2EB;font-size:12.5px;font-weight:600;padding:5px 8px;
      border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
    .pe-blocktb button:hover{background:rgba(255,255,255,.16)}
    .pe-blocktb button.dan:hover{background:#E1361C}`;
  doc.head.appendChild(st);

  blockTb = doc.createElement("div");
  blockTb.className = "pe-blocktb pe-ui";
  blockTb.innerHTML = `
    <button data-a="dup">⧉ 블럭 복제</button>
    <button data-a="del" class="dan">🗑 블럭 삭제</button>`;
  doc.body.appendChild(blockTb);
  blockTb.addEventListener("mousedown", (e) => e.preventDefault());   // 편집 포커스 유지
  blockTb.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a || !blockEl) return;
    if (a === "dup") duplicateBlock(blockEl);
    if (a === "del") deleteBlock(blockEl);
  });

  // 편집에 들어간 블럭을 따라다닌다
  doc.addEventListener("focusin", (e) => {
    const b = e.target.closest?.(TEXT_BLOCKS + "," + EXTRA_TEXT);
    if (b && b.isContentEditable && !b.closest(".pe-ui") && !b.classList.contains("pe-cap")) showBlockTb(b);
    else hideBlockTb();
  });
  doc.addEventListener("focusout", (e) => {
    // 툴바 버튼을 누르는 중이면 유지한다 (mousedown 을 막아 두어 포커스는 안 뺏기지만 안전망)
    setTimeout(() => { if (doc.activeElement !== blockEl && !blockTb.contains(doc.activeElement)) hideBlockTb(); }, 0);
  });
  addEventListener("scroll", placeBlockTb, true);
}

function showBlockTb(b) {
  blockEl = b;
  blockTb.style.display = "flex";
  placeBlockTb();
}
function placeBlockTb() {
  if (!blockEl || !blockTb || blockTb.style.display === "none") return;
  const r = blockEl.getBoundingClientRect();
  blockTb.style.left = Math.max(8, Math.min(r.right - blockTb.offsetWidth, doc.documentElement.clientWidth - blockTb.offsetWidth - 8)) + "px";
  blockTb.style.top = Math.max(8, r.top - blockTb.offsetHeight - 8) + "px";
}
function hideBlockTb() { blockEl = null; if (blockTb) blockTb.style.display = "none"; }

function duplicateBlock(b) {
  snap();
  const c = b.cloneNode(true);
  b.after(c);
  c.setAttribute("contenteditable", "true");
  markDirty();
  c.focus();
  toast("블럭을 복제했습니다 — 아래쪽이 새 블럭입니다");
}

function deleteBlock(b) {
  snap();
  const parent = b.parentElement;
  b.remove();
  // 마지막 항목까지 지워 빈 목록만 남으면 목록째 걷어낸다
  if (parent && ["UL", "OL"].includes(parent.tagName) && !parent.querySelector("li")) parent.remove();
  hideBlockTb();
  markDirty();
  toast("블럭을 지웠습니다 (⌘Z로 되돌릴 수 있습니다)");
}

/* ───────────────────────── 새 슬라이드 = 기본 폼
 *
 * 빈 <section> 을 주면 그때부터 조판을 사람이 다 해야 한다.
 * 대신 이 덱들이 공유하는 뼈대(.pad 제목 / .body 본문 / .folio 쪽번호)로 짠
 * 기본 폼 몇 가지를 주고 고르게 한다. 넣은 뒤엔 여느 장처럼 글자만 고치면 된다.
 */
const SLIDE_FORMS = [
  { id: "title-body", name: "제목 + 본문",   hint: "가장 기본 꼴" },
  { id: "bullets",    name: "제목 + 불릿",   hint: "요점 나열" },
  { id: "section",    name: "섹션 간지",     hint: "장 사이 구분" },
  { id: "statement",  name: "큰 문장 하나",  hint: "선언·전환" },
  { id: "blank",      name: "빈 슬라이드",   hint: "직접 채우기" },
];

/** 덱이 쓰는 쪽번호·꼬리표 표기를 이웃 장에서 훔쳐 온다. */
function slideScaffold(formId) {
  const anyFolio = stage().querySelector(".slide .folio")?.textContent.trim() || "00";
  const folio = `<div class="folio">${"0".repeat(anyFolio.length)}</div>`;
  const folioL = stage().querySelector(".slide .folio-l");
  const tail = folio + (folioL ? `<div class="folio-l">${folioL.textContent}</div>` : "");

  const M = {
    "title-body": `
  <div class="pad">
    <div class="eyebrow">EYEBROW — 작은 머리말</div>
    <h2>제목을 눌러서 고치세요</h2>
    <div class="head-rule"></div>
  </div>
  <div class="body">
    <p style="font-size:29px;font-weight:300;line-height:1.65;max-width:1500px;margin:0">
      본문 — 눌러서 고치세요. 엔터를 치면 줄이 바뀝니다.</p>
  </div>`,
    "bullets": `
  <div class="pad">
    <div class="eyebrow">EYEBROW — 작은 머리말</div>
    <h2>제목을 눌러서 고치세요</h2>
    <div class="head-rule"></div>
  </div>
  <div class="body">
    <ul style="font-size:29px;font-weight:300;line-height:1.9;max-width:1500px;margin:0;padding-left:1.1em">
      <li>첫 번째 요점 — 눌러서 고치세요</li>
      <li>두 번째 요점</li>
      <li>세 번째 요점</li>
    </ul>
  </div>`,
    "section": `
  <div class="bar"></div>
  <div class="kick">SECTION 00</div>
  <div class="num">00</div>
  <h2>섹션 제목을<br>눌러서 고치세요</h2>
  <div class="note">이 섹션이 다루는 내용을 한 줄로.</div>`,
    "statement": `
  <div class="body" style="display:flex;align-items:center;justify-content:center;position:absolute;inset:0">
    <p class="statement" style="font-size:64px;font-weight:600;line-height:1.4;text-align:center;max-width:1500px;margin:0">
      하고 싶은 말 한 문장을<br>눌러서 고치세요</p>
  </div>`,
    "blank": ``,
  };
  return (M[formId] ?? "") + tail;
}

function insertSlide(formId) {
  snap();
  const s = doc.createElement("section");
  s.className = "slide" + (formId === "section" ? " sec" : "");
  s.innerHTML = slideScaffold(formId);
  curSlide().after(s);
  renumberFolios();
  enableEditing();
  buildRail();
  show(current + 1);
  markDirty();
  toast("새 슬라이드를 넣었습니다 — 글자를 눌러 고치세요");
}

/* 폼 고르기 패널 */
let newChoice = null;
function openNewPane() {
  newChoice = SLIDE_FORMS[0].id;
  const grid = $("#newOpts");
  grid.innerHTML = SLIDE_FORMS.map((f) => `
    <button class="pe-opt${f.id === newChoice ? " on" : ""}" data-id="${f.id}">
      <span class="dg">${formDiagram(f.id)}</span>
      <b>${f.name}</b><span>${f.hint}</span>
    </button>`).join("");
  grid.querySelectorAll(".pe-opt").forEach((b) => b.onclick = () => {
    newChoice = b.dataset.id;
    grid.querySelectorAll(".pe-opt").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#newPaneSub").textContent = `${current + 1}번 장 뒤에 들어갑니다. 넣은 뒤 글자를 눌러 고치세요.`;
  $("#newPane").classList.add("show");
}
function closeNewPane() { $("#newPane").classList.remove("show"); }

/** 폼 미리보기 — 회색이 글 자리 */
function formDiagram(id) {
  const M = {
    "title-body": `<u style="left:6%;top:10%;width:60%;height:13%;background:rgba(20,21,15,.34)"></u><u style="left:6%;top:34%;width:80%;height:7%"></u><u style="left:6%;top:47%;width:72%;height:7%"></u><u style="left:6%;top:60%;width:76%;height:7%"></u>`,
    "bullets":    `<u style="left:6%;top:10%;width:60%;height:13%;background:rgba(20,21,15,.34)"></u><u style="left:10%;top:36%;width:60%;height:7%"></u><u style="left:10%;top:52%;width:52%;height:7%"></u><u style="left:10%;top:68%;width:56%;height:7%"></u>`,
    "section":    `<u style="left:6%;top:14%;width:22%;height:8%"></u><u style="left:6%;top:36%;width:56%;height:16%;background:rgba(20,21,15,.34)"></u><u style="left:6%;top:58%;width:42%;height:16%;background:rgba(20,21,15,.34)"></u>`,
    "statement":  `<u style="left:14%;top:38%;width:72%;height:11%;background:rgba(20,21,15,.34)"></u><u style="left:24%;top:54%;width:52%;height:11%;background:rgba(20,21,15,.34)"></u>`,
    "blank":      ``,
  };
  return M[id] || "";
}

$("#newCancel").onclick = closeNewPane;
$("#newGo").onclick = () => { insertSlide(newChoice); closeNewPane(); };
$("#newPane").addEventListener("mousedown", (e) => { if (e.target.id === "newPane") closeNewPane(); });

/* ───────────────────────── 이미지 = 레이아웃 슬롯
 *
 * 자유 배치를 없앤 이유: 끌어 옮긴 이미지는 장이 바뀌거나 글이 늘면 곧바로 어긋난다.
 * 대신 슬라이드가 「어디에 몇 장」을 먼저 정하고(프리셋), 그 자리(.pe-slot)에만 앉힌다.
 * 위치·크기는 슬라이드가 책임지고, 사람은 무엇을 넣을지만 고른다.
 */
const IMG_PRESETS = [
  { id: "right-1",  n: 1, name: "오른쪽 1장",     hint: "본문 왼쪽 정렬" },
  { id: "left-1",   n: 1, name: "왼쪽 1장",       hint: "본문 오른쪽으로" },
  { id: "right-2",  n: 2, name: "오른쪽 세로 2장", hint: "비교·전후" },
  { id: "bottom-3", n: 3, name: "하단 가로 3장",   hint: "사례 나열" },
  { id: "top-1",    n: 1, name: "상단 와이드 1장", hint: "표지·전환" },
  { id: "full-1",   n: 1, name: "전면 배경 1장",   hint: "글이 이미지 위에" },
];
/* 영상이 앉을 수 있는 배치. 이미지 배치를 그대로 쓰고, 첫 장용 하나만 더한다. */
const CINEMA = { id: "cinema", n: 1, name: "시네마 오프닝", hint: "영상 먼저, 글은 나중 — 첫 장용" };
const VIDEO_PRESETS = [
  CINEMA,
  { id: "full-1",  n: 1, name: "전면 배경",     hint: "글이 영상 위에" },
  { id: "right-1", n: 1, name: "오른쪽 1칸",    hint: "본문 왼쪽 정렬" },
  { id: "left-1",  n: 1, name: "왼쪽 1칸",      hint: "본문 오른쪽으로" },
  { id: "top-1",   n: 1, name: "상단 와이드",   hint: "표지·전환" },
];
const ALL_PRESETS = [...IMG_PRESETS, CINEMA];
const presetOf = (id) => ALL_PRESETS.find((p) => p.id === id) || null;
/* 본문을 좁히지 않는 배치 — 글이 영상 위에 얹히는 것들 */
const OVERLAY_POS = new Set(["full-1", "cinema"]);

/** 레이아웃 CSS 는 무대 안에 넣는다 — 저장 대상이 무대뿐이라, 발표·PDF 에서도 같이 산다. */
const LAYOUT_CSS = `
/* 제목(.pad)·쪽번호(.folio)는 손대지 않는다. 좁히는 것은 본문 상자 하나뿐이다.
   슬라이드를 통째로 축소하면 헤드라인까지 작아지고 조판이 무너진다 — 그 길은 이미 틀렸다. */
.pe-imgzone{position:absolute;display:grid;gap:22px;z-index:4}
.pe-slot{position:relative;overflow:hidden;background:#fff;border:1px solid rgba(20,21,15,.14)}
.pe-slot>img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}
.pe-slot[data-fit="contain"]>img{object-fit:contain;background:#fff}
.pe-slot>.pe-cap{position:absolute;left:0;right:0;bottom:0;background:rgba(20,21,15,.86);color:#F5F2EB;
  font-size:16px;letter-spacing:.06em;padding:9px 13px;margin:0}

.slide[data-pe-img="right-1"] .pe-bodybox,
.slide[data-pe-img="right-2"] .pe-bodybox{right:756px}
.pe-imgzone[data-pos="right-1"],.pe-imgzone[data-pos="right-2"]{left:1236px;top:262px;width:588px;height:722px}
.pe-imgzone[data-pos="right-2"]{grid-template-rows:1fr 1fr}

.slide[data-pe-img="left-1"] .pe-bodybox{left:756px}
.pe-imgzone[data-pos="left-1"]{left:96px;top:262px;width:588px;height:722px}

.slide[data-pe-img="bottom-3"] .pe-bodybox{bottom:398px}
.pe-imgzone[data-pos="bottom-3"]{left:96px;top:722px;width:1728px;height:262px;grid-template-columns:repeat(3,1fr)}

.slide[data-pe-img="top-1"] .pe-bodybox{top:562px}
.pe-imgzone[data-pos="top-1"]{left:96px;top:262px;width:1728px;height:260px}

.pe-imgzone[data-pos="full-1"]{left:0;top:0;width:1920px;height:1080px;z-index:0}
.pe-imgzone[data-pos="full-1"] .pe-slot{border:0}
.slide[data-pe-img="full-1"]>:not(.pe-imgzone){z-index:2}
.slide[data-pe-img="full-1"] .pe-imgzone::after{content:"";position:absolute;inset:0;z-index:1;
  background:linear-gradient(90deg,rgba(20,21,15,.74) 0%,rgba(20,21,15,.32) 62%,rgba(20,21,15,.10) 100%)}

/* 영상은 이미지와 같은 칸에 앉는다 — 배치를 새로 만들지 않는다 */
.pe-slot>video{display:block;width:100%;height:100%;object-fit:cover;object-position:center;background:#0b0b09}
.pe-slot[data-fit="contain"]>video{object-fit:contain}

/* 어두운 화면 위에 검은 글씨는 안 읽힌다. 영상·사진을 깔면 글자를 밝게 뒤집는다. */
.slide[data-pe-ink="light"]{color:#F5F2EB}
.slide[data-pe-ink="light"] :is(h1,h2,h3,h4,p,li,td,th,div,span,b,strong,em,small,figcaption){color:#F5F2EB}
.slide[data-pe-ink="light"] :is(u,mark,.strong,.hl,.accent){color:var(--accent,#E1361C)}
.slide[data-pe-ink="light"] :is(hr,.t-rule,.head-rule,.rule,.line){background:rgba(245,242,235,.28);border-color:rgba(245,242,235,.28)}
.slide[data-pe-ink="light"] :is(table,th,td){border-color:rgba(245,242,235,.22)}
.slide[data-pe-ink="light"] .pe-cap{background:rgba(11,11,9,.78)}

/* 시네마 오프닝 — 첫 장 전용. 어둠은 글을 읽히게 하려고만 있다. */
.pe-imgzone[data-pos="cinema"]{left:0;top:0;width:1920px;height:1080px;z-index:0;gap:0}
.pe-imgzone[data-pos="cinema"] .pe-slot{border:0;background:#0b0b09}
.slide[data-pe-img="cinema"]>:not(.pe-imgzone){z-index:2}
.pe-imgzone[data-pos="cinema"]::after{content:"";position:absolute;inset:0;z-index:1;
  background:linear-gradient(90deg,rgba(11,11,9,.80) 0%,rgba(11,11,9,.42) 58%,rgba(11,11,9,.14) 100%)}

/* 🔴 시네마 영상은 1920x1080 을 통째로 덮는다 — 화면의 모든 마우스 동작이 영상 위에서 일어난다.
   ①어둠막(::after)이 포인터를 가로채면 영상의 호버 컨트롤(🔊·재생·진행바)에 영영 못 닿는다
     (지문: Playwright hover 가 "pe-imgzone intercepts pointer events" 로 30초 타임아웃).
   ②영상이 포인터를 받으면 런타임의 click 핸들러가 재생/멈춤을 삼킨다 — 발표 중 화면을
     한 번 누른 것이 영상 정지가 된다.
   둘 다 투명하게 두고 마우스는 .pe-slot 이 받는다 — 그래야 컨트롤이 뜨고 영상은 계속 돈다.
   .pe-vbar 는 보일 때만 pointer-events:auto 라 버튼은 그대로 눌린다.
   (2026-09-22 3기 마지막 코호트 덱이 첫 실사용) */
.pe-imgzone[data-pos="cinema"]::after{pointer-events:none}
.pe-imgzone[data-pos="cinema"] .pe-slot>video{pointer-events:none}
`;

/** 옛 방식(슬라이드 전체를 .pe-body 로 감싸 축소)으로 저장된 덱을 원래 조판으로 되돌린다. */
function migrateOldBody() {
  for (const body of stage().querySelectorAll(".pe-body")) {
    const sl = body.parentElement;
    while (body.firstChild) sl.insertBefore(body.firstChild, body);
    body.remove();
  }
}

/** 다시 열었을 때 — 저장 때 벗겨 낸 빈 칸을 프리셋 개수에 맞춰 되살린다. */
function rehydrateSlots() {
  migrateOldBody();
  for (const s of slides()) {
    const p = presetOf(s.dataset.peImg);
    if (!p) continue;
    const zone = s.querySelector(".pe-imgzone");
    if (!zone || !zone.querySelector(".pe-slot")) { zone?.remove(); releaseBody(s); delete s.dataset.peImg; continue; }
    markBody(s);
    zone.querySelectorAll(".pe-slot").forEach((sl) => { if (!sl.querySelector("img,video")) sl.classList.add("pe-empty"); });
    while (zone.querySelectorAll(".pe-slot").length < p.n) {
      const sl = doc.createElement("div");
      sl.className = "pe-slot pe-empty";
      zone.appendChild(sl);
    }
    bindCaptions(zone);
  }
}

function ensureLayoutCss() {
  const st = stage();
  let el = st.querySelector("style#pe-layout-css");
  if (!el) { el = doc.createElement("style"); el.id = "pe-layout-css"; st.prepend(el); }
  if (el.textContent.trim() !== LAYOUT_CSS.trim()) el.textContent = LAYOUT_CSS;
}

/* 편집 중에만 보이는 빈 칸 안내 — 저장 때 벗긴다 */
const SLOT_UI_CSS = `.pe-slot.pe-empty{background:repeating-linear-gradient(45deg,#f4f2ec,#f4f2ec 12px,#eae7de 12px,#eae7de 24px);
    border:2px dashed rgba(225,54,28,.5);display:flex;align-items:center;justify-content:center;cursor:pointer}
  .pe-slot.pe-empty::after{content:"＋ 이미지";font-family:'Pretendard',sans-serif;font-size:22px;font-weight:600;color:#E1361C}
  .pe-slot>img{cursor:pointer}
  .pe-slot.pe-picked{outline:3px solid #E1361C;outline-offset:-3px}
  .pe-imgtb{position:fixed;z-index:99999;background:#14150F;border-radius:9px;padding:5px 6px;display:none;gap:2px;
    box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:'Pretendard',sans-serif}
  .pe-imgtb button{border:0;background:transparent;color:#F5F2EB;font-size:13px;font-weight:600;padding:6px 9px;
    border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
  .pe-imgtb button:hover{background:rgba(255,255,255,.16)}
  .pe-imgtb button.dan:hover{background:#E1361C}
  .pe-imgtb button.on{background:#E1361C;color:#fff}
  .pe-imgtb button.on:hover{background:#c72d15}
  .pe-vidtb{flex-wrap:wrap;max-width:640px}
  .pe-slot.pe-picked>video{filter:brightness(.92)}
  .pe-vbadge{position:absolute;left:12px;top:12px;z-index:8;border:0;border-radius:7px;cursor:pointer;
    background:rgba(20,21,15,.82);color:#F5F2EB;font-family:'Pretendard',sans-serif;font-size:13px;
    font-weight:600;padding:7px 11px;backdrop-filter:blur(6px)}
  .pe-vbadge:hover{background:#E1361C}`;

/** 프리셋을 슬라이드에 입힌다. 기존 이미지는 순서대로 새 칸에 옮겨 담는다. */
function applyImgLayout(slideEl, presetId) {
  const p = presetOf(presetId);
  if (!p) return;
  snap();
  const hasBody = !!markBody(slideEl);
  const old = slideEl.querySelector(".pe-imgzone");
  const keep = old ? [...old.querySelectorAll(".pe-slot")].filter((s) => s.querySelector("img,video")) : [];
  if (old) old.remove();

  const zone = doc.createElement("div");
  zone.className = "pe-imgzone";
  zone.dataset.pos = p.id;
  for (let i = 0; i < p.n; i++) {
    const slot = keep[i] || doc.createElement("div");
    slot.className = "pe-slot" + (slot.querySelector?.("img,video") ? "" : " pe-empty");
    zone.appendChild(slot);
  }
  slideEl.dataset.peImg = p.id;
  slideEl.appendChild(zone);
  bindCaptions(zone);
  markDirty();
  if (!hasBody && !OVERLAY_POS.has(p.id))
    toast("이 장은 본문 구조가 달라 자리를 자동으로 비우지 못했습니다 — 글과 겹치면 다른 배치를 고르세요");
}

/* 본문 상자 찾기.
 * 이 덱들은 .pad(제목) / .body(본문) / .folio(쪽번호) 로 나뉘어 있다 — 그럴 땐 .body 만 좁힌다.
 * .body 가 없는 장(섹션 간지 등)은 자동으로 자리를 비울 방법이 없다. 억지로 묶으면 조판이 옮겨진다.
 * 그럴 땐 아무것도 건드리지 않고 이미지만 얹은 뒤, 겹칠 수 있다고 알린다. */
function markBody(slideEl) {
  const box = slideEl.querySelector(":scope > .body");
  if (!box) return null;
  box.classList.add("pe-bodybox");
  return box;
}
function releaseBody(slideEl) {
  const box = slideEl.querySelector(":scope > .pe-bodybox");
  if (!box) return;
  box.classList.remove("pe-bodybox");
  if (!box.classList.contains("pe-bodywrap")) return;
  while (box.firstChild) slideEl.insertBefore(box.firstChild, box);   // 옛 버전이 만든 상자만 걷어낸다
  box.remove();
}

function clearImgLayout(slideEl) {
  snap();
  delete slideEl.dataset.peInk;
  slideEl.querySelector(".pe-imgzone")?.remove();
  releaseBody(slideEl);
  delete slideEl.dataset.peImg;
  unpickImage();
  markDirty();
}

function bindCaptions(root) {
  root.querySelectorAll(".pe-cap").forEach((c) => c.setAttribute("contenteditable", "true"));
}

/** 파일 하나를 올려 서버 URL 을 돌려준다. */
async function uploadImage() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
  const file = await new Promise((ok) => { inp.onchange = () => ok(inp.files[0] || null); inp.click(); });
  if (!file) return null;
  if (file.size > 12 * 1024 * 1024) { toast("12MB 이하 이미지만 넣을 수 있습니다"); return null; }
  toast("올리는 중…");
  const dataUrl = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); });
  const r = await (await fetch(`/api/assets/${encodeURIComponent(slug)}`, { method: "POST",
    body: JSON.stringify({ name: file.name, dataUrl }) })).json();
  if (!r.url) { toast(r.error || "업로드 실패"); return null; }
  return r.url;
}

async function fillSlot(slot) {
  const url = await uploadImage();
  if (!url) return;
  snap();
  const img = slot.querySelector("img");
  if (img) { img.src = url; }
  else {
    slot.insertAdjacentHTML("afterbegin", `<img src="${url}" alt="">`);
    slot.classList.remove("pe-empty");
  }
  markDirty();
  toast("넣었습니다 — 이미지를 누르면 교체·캡션·삭제를 할 수 있습니다");
}

/* ───────────────────────── 이미지·영상 선택 · 도구막대 */
let picked = null, imgTb = null, curTb = null;

function enableImagePick() {
  const st = doc.createElement("style");
  st.className = "pe-ui";
  st.textContent = SLOT_UI_CSS;
  doc.head.appendChild(st);

  imgTb = doc.createElement("div");
  imgTb.className = "pe-imgtb pe-ui";
  imgTb.innerHTML = `
    <button data-a="swap">교체</button>
    <button data-a="cap">캡션</button>
    <button data-a="fit">여백맞춤</button>
    <button data-a="del" class="dan">삭제</button>`;
  doc.body.appendChild(imgTb);
  imgTb.addEventListener("mousedown", (e) => e.preventDefault());
  imgTb.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a || !picked) return;
    if (a === "swap") return fillSlot(picked);
    if (a === "del") return removeImage(picked);
    if (a === "cap") {
      snap();
      const cap = picked.querySelector(".pe-cap");
      if (cap) cap.remove();
      else {
        const c = doc.createElement("div");
        c.className = "pe-cap";
        c.textContent = "캡션 — 눌러서 고치세요";
        c.setAttribute("contenteditable", "true");
        picked.appendChild(c);
      }
      markDirty(); placeImgTb();
    }
    if (a === "fit") {
      snap();
      picked.dataset.fit = picked.dataset.fit === "contain" ? "cover" : "contain";
      markDirty();
    }
  });

  doc.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (t.closest?.(".pe-ui,.pe-imgtb,.pe-slidetb,.pe-seltb,.pe-vbar")) return;
    if (t.classList?.contains("pe-cap")) return;              // 캡션은 글자 편집
    const slot = t.closest?.(".pe-slot");
    if (slot) {
      e.preventDefault();
      if (slot.classList.contains("pe-empty")) {
        unpickImage();
        const wantsVideo = slot.closest(".pe-imgzone")?.dataset.media === "video";
        wantsVideo ? fillVideoSlot(slot) : fillSlot(slot);
        return;
      }
      pickImage(slot);
      return;
    }
    // 예전에 자유 배치로 꽂아 둔 이미지(.shot)도 고르고 지울 수 있게 남겨 둔다
    const legacy = t.closest?.(".shot") || (t.tagName === "IMG" ? t : null);
    if (legacy && !legacy.closest(".pe-ui")) { e.preventDefault(); pickImage(legacy); return; }
    unpickImage();
  });

  doc.addEventListener("keydown", (e) => {
    if (!picked) return;
    if (e.target.isContentEditable) return;
    if (e.key === "Escape") return unpickImage();
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      isVideoSlot(picked) ? removeVideo(picked) : removeImage(picked);
    }
  });
  addEventListener("scroll", placeImgTb, true);
}

function pickImage(el) {
  if (picked === el) return placeImgTb();
  unpickImage();
  picked = el;
  el.classList.add("pe-picked");
  curTb = isVideoSlot(el) ? vidTb : imgTb;      // 영상 칸은 재생 옵션을 내민다
  if (curTb === vidTb) paintVidTb();
  curTb.style.display = "flex";
  placeImgTb();
}

function placeImgTb() {
  const tb = curTb;
  if (!picked || !tb) return;
  const r = picked.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - tb.offsetWidth / 2, innerWidth - tb.offsetWidth - 8));
  // 전면 배치는 칸이 화면을 가득 채운다 — 위에 둘 자리가 없으면 안쪽 아래에 붙인다
  const above = r.top - tb.offsetHeight - 10;
  tb.style.left = left + "px";
  tb.style.top = (above > 8 ? above : Math.min(r.bottom - tb.offsetHeight - 16, innerHeight - tb.offsetHeight - 12)) + "px";
}

function unpickImage() {
  if (picked) picked.classList.remove("pe-picked");
  picked = null;
  if (imgTb) imgTb.style.display = "none";
  if (vidTb) vidTb.style.display = "none";
  curTb = null;
}

function removeImage(el) {
  snap();
  if (el.classList.contains("pe-slot")) {
    el.querySelector("img")?.remove();
    el.querySelector(".pe-cap")?.remove();
    delete el.dataset.fit;
    el.classList.add("pe-empty");
  } else {
    el.remove();                                              // 예전 자유 배치 이미지
  }
  unpickImage(); markDirty();
  toast("이미지를 지웠습니다");
}

/* ───────────────────────── 레이아웃 고르기 패널 */
let paneChoice = null;
function openImgPane() {
  const s = curSlide();
  paneChoice = s.dataset.peImg || null;
  const grid = $("#imgOpts");
  grid.innerHTML = IMG_PRESETS.map((p) => `
    <button class="pe-opt${p.id === paneChoice ? " on" : ""}" data-id="${p.id}">
      <span class="dg">${presetDiagram(p.id)}</span>
      <b>${p.name}</b><span>${p.hint}</span>
    </button>`).join("");
  grid.querySelectorAll(".pe-opt").forEach((b) => b.onclick = () => {
    paneChoice = b.dataset.id;
    grid.querySelectorAll(".pe-opt").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#imgClear").style.display = s.dataset.peImg ? "" : "none";
  $("#imgPaneSub").textContent = `${current + 1}번 슬라이드 · 고르면 본문 폭이 자동으로 줄고 이미지 칸이 생깁니다.`;
  $("#imgPane").classList.add("show");
}
function closeImgPane() { $("#imgPane").classList.remove("show"); }

/** 프리셋 미리보기 — 빨강이 이미지, 회색이 글 */
function presetDiagram(id) {
  const head = `<u style="left:6%;top:10%;width:60%;height:13%;background:rgba(20,21,15,.34)"></u>`;
  const M = {
    "right-1":  `<u style="left:6%;top:34%;width:38%;height:9%"></u><u style="left:6%;top:50%;width:30%;height:7%"></u><u style="left:6%;top:64%;width:34%;height:7%"></u><i style="left:56%;top:32%;width:38%;height:56%"></i>`,
    "left-1":   `<i style="left:6%;top:32%;width:38%;height:56%"></i><u style="left:56%;top:34%;width:38%;height:9%"></u><u style="left:56%;top:50%;width:30%;height:7%"></u><u style="left:56%;top:64%;width:34%;height:7%"></u>`,
    "right-2":  `<u style="left:6%;top:34%;width:38%;height:9%"></u><u style="left:6%;top:50%;width:30%;height:7%"></u><u style="left:6%;top:64%;width:34%;height:7%"></u><i style="left:56%;top:32%;width:38%;height:26%"></i><i style="left:56%;top:62%;width:38%;height:26%"></i>`,
    "bottom-3": `<u style="left:6%;top:32%;width:56%;height:8%"></u><u style="left:6%;top:45%;width:40%;height:7%"></u><i style="left:6%;top:62%;width:28%;height:26%"></i><i style="left:36%;top:62%;width:28%;height:26%"></i><i style="left:66%;top:62%;width:28%;height:26%"></i>`,
    "top-1":    `<i style="left:6%;top:28%;width:88%;height:30%"></i><u style="left:6%;top:66%;width:56%;height:8%"></u><u style="left:6%;top:80%;width:40%;height:7%"></u>`,
    "full-1":   `<i style="left:0;top:0;width:100%;height:100%"></i>`,
    "cinema":   `<i style="left:0;top:0;width:100%;height:100%"></i>`,
  };
  const overlay = OVERLAY_POS.has(id);
  const onTop = `<u style="left:8%;top:22%;width:56%;height:13%;background:rgba(255,255,255,.92)"></u><u style="left:8%;top:44%;width:34%;height:8%;background:rgba(255,255,255,.72)"></u>`;
  // 시네마는 「글이 나중에 온다」를 흐리게 그려 보여 준다
  const later = `<u style="left:8%;top:22%;width:56%;height:13%;background:rgba(255,255,255,.34)"></u><u style="left:8%;top:44%;width:34%;height:8%;background:rgba(255,255,255,.22)"></u><u style="left:8%;top:66%;width:22%;height:6%;background:rgba(255,255,255,.14)"></u>`;
  return (overlay ? "" : head) + (M[id] || "") + (id === "cinema" ? later : overlay ? onTop : "");
}

$("#imgCancel").onclick = closeImgPane;
$("#imgGo").onclick = () => {
  if (!paneChoice) return toast("배치를 하나 고르세요");
  applyImgLayout(curSlide(), paneChoice);
  closeImgPane();
  toast("배치를 적용했습니다 — 빈 칸을 누르면 이미지를 고를 수 있습니다");
};
$("#imgClear").onclick = () => { clearImgLayout(curSlide()); closeImgPane(); toast("레이아웃을 해제했습니다"); };
$("#imgPane").addEventListener("mousedown", (e) => { if (e.target.id === "imgPane") closeImgPane(); });

/* ───────────────────────── 영상 = 같은 칸, 다른 재생 규칙
 *
 * 이미지와 배치를 나눠 쓴다 — 자리·크기 규칙을 두 벌 만들 이유가 없다.
 * 다른 것은 「어떻게 트나」뿐이고, 그건 슬롯에 적어 둔다:
 *   data-autoplay 1/0 · data-loop 1/0 · data-sound 1/0 · data-delay(시네마 전용, ms)
 * 발표 장치(lib/video-runtime.mjs)가 이 값을 읽어 재생한다.
 */
const VIDEO_LIMIT_MB = 300;

/** 영상 한 편을 올려 서버 URL 을 돌려준다. base64 로 바꾸지 않고 파일 그대로 흘려보낸다. */
async function uploadVideo() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov";
  const file = await new Promise((ok) => { inp.onchange = () => ok(inp.files[0] || null); inp.click(); });
  if (!file) return null;
  const mb = file.size / (1024 * 1024);
  if (mb > VIDEO_LIMIT_MB) { toast(`${VIDEO_LIMIT_MB}MB 이하 영상만 넣을 수 있습니다`); return null; }
  toast(`올리는 중… ${Math.round(mb)}MB`);
  let r;
  try {
    r = await (await fetch(`/api/videos/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name) },
      body: file,
    })).json();
  } catch { toast("업로드 실패 — 파일이 너무 크거나 연결이 끊겼습니다"); return null; }
  if (!r.url) { toast(r.error || "업로드 실패"); return null; }
  toast(r.warn || `넣었습니다 (${r.sizeMB}MB)`);
  return r.url;
}

async function fillVideoSlot(slot) {
  const url = await uploadVideo();
  if (!url) return;
  snap();
  slot.querySelector("img")?.remove();
  let v = slot.querySelector("video");
  if (v) { v.removeAttribute("poster"); delete slot.dataset.poster; v.src = url; }
  else {
    slot.insertAdjacentHTML("afterbegin", `<video src="${url}" muted loop playsinline preload="auto"></video>`);
    slot.classList.remove("pe-empty");
    v = slot.querySelector("video");
  }
  if (!slot.dataset.autoplay) slot.dataset.autoplay = "1";
  if (!slot.dataset.loop) slot.dataset.loop = "1";
  if (!slot.dataset.sound) slot.dataset.sound = "0";
  if (isCinema(slot) && !slot.dataset.delay) slot.dataset.delay = "2500";
  markDirty();
  paintVideoBadges();
  grabPoster(slot, true);          // 첫 화면은 알아서 잡아 둔다 — PDF 가 비지 않게
  toast("영상을 넣었습니다 — 눌러서 자동재생·반복·소리를 고르세요");
}

const isVideoSlot = (el) => !!el?.querySelector?.("video");

/* 전면·시네마 배치에서는 글이 영상 위를 덮어 칸을 누를 수가 없다.
   편집기에서만 보이는 작은 손잡이를 칸마다 붙여 둔다 (저장 때 .pe-ui 로 벗겨진다). */
function paintVideoBadges() {
  for (const slot of stage().querySelectorAll(".pe-slot")) {
    const has = isVideoSlot(slot);
    const badge = slot.querySelector(":scope > .pe-vbadge");
    if (!has) { badge?.remove(); continue; }
    if (badge) continue;
    const b = doc.createElement("button");
    b.className = "pe-vbadge pe-ui";
    b.type = "button";
    b.textContent = "🎬 재생 설정";
    b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pickImage(slot); });
    slot.appendChild(b);
  }
}
const isCinema = (slot) => slot?.closest?.(".pe-imgzone")?.dataset.pos === "cinema";

/** 지금 보이는 화면을 PNG 로 떠서 poster 로 삼는다 — 영상은 인쇄되지 않는다. */
async function grabPoster(slot, quiet) {
  const v = slot.querySelector("video");
  if (!v) return;
  try {
    if (v.readyState < 2) {
      await new Promise((ok, no) => {
        v.addEventListener("loadeddata", ok, { once: true });
        v.addEventListener("error", () => no(new Error("load")), { once: true });
        setTimeout(() => no(new Error("timeout")), 10000);
      });
    }
    if (quiet) {
      // 맨 앞은 검은 프레임인 경우가 많다. 살짝 뒤로 간다.
      const at = Math.min(0.4, (v.duration || 2) * 0.04);
      if (Math.abs(v.currentTime - at) > 0.05) {
        v.currentTime = at;
        await new Promise((ok) => { v.addEventListener("seeked", ok, { once: true }); setTimeout(ok, 2000); });
      }
    }
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 1920;
    c.height = v.videoHeight || 1080;
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    const r = await (await fetch(`/api/posters/${encodeURIComponent(slug)}`, {
      method: "POST", body: JSON.stringify({ dataUrl }),
    })).json();
    if (!r.url) throw new Error(r.error || "실패");
    slot.dataset.poster = r.url;
    v.setAttribute("poster", r.url);
    markDirty();
    if (!quiet) toast("이 화면을 첫 화면으로 잡았습니다 — PDF 에도 이 그림이 들어갑니다");
  } catch {
    if (!quiet) toast("첫 화면을 잡지 못했습니다 — 영상을 조금 재생한 뒤 다시 해보세요");
  }
}

/* 재생 옵션 도구막대 */
let vidTb = null;
const DELAYS = [0, 1500, 2500, 4000];
const delayLabel = (ms) => (+ms === 0 ? "글 바로" : `글 ${(+ms / 1000).toFixed(1).replace(".0", "")}초 뒤`);

function buildVideoToolbar() {
  vidTb = doc.createElement("div");
  vidTb.className = "pe-imgtb pe-vidtb pe-ui";
  vidTb.innerHTML = `
    <button data-a="swap">교체</button>
    <button data-a="autoplay" data-t="1">▶ 자동재생</button>
    <button data-a="loop" data-t="1">↻ 반복</button>
    <button data-a="sound" data-t="1">🔊 소리</button>
    <button data-a="delay" class="only-cine">글 2.5초 뒤</button>
    <button data-a="ink">글자 밝게</button>
    <button data-a="poster">첫 화면 잡기</button>
    <button data-a="fit">여백맞춤</button>
    <button data-a="del" class="dan">삭제</button>`;
  doc.body.appendChild(vidTb);
  vidTb.addEventListener("mousedown", (e) => e.preventDefault());
  vidTb.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a || !picked) return;
    if (a === "swap") return fillVideoSlot(picked);
    if (a === "del") return removeVideo(picked);
    if (a === "poster") return grabPoster(picked, false);
    snap();
    if (a === "autoplay" || a === "loop" || a === "sound") {
      const on = picked.dataset[a] !== "0";
      picked.dataset[a] = on ? "0" : "1";
      if (a === "loop") picked.querySelector("video").loop = !on;
      if (a === "sound" && !on) toast("소리는 발표 중 영상 위에서 🔊 를 눌러야 켜집니다 (브라우저가 막습니다)");
    }
    if (a === "delay") {
      const now = parseInt(picked.dataset.delay || "2500", 10);
      picked.dataset.delay = String(DELAYS[(DELAYS.indexOf(now) + 1) % DELAYS.length]);
    }
    if (a === "fit") picked.dataset.fit = picked.dataset.fit === "contain" ? "cover" : "contain";
    if (a === "ink") {
      const sl = picked.closest(".slide");
      if (sl.dataset.peInk === "light") delete sl.dataset.peInk;
      else sl.dataset.peInk = "light";
    }
    markDirty();
    paintVidTb();
  });
}

function paintVidTb() {
  if (!vidTb || !picked) return;
  for (const b of vidTb.querySelectorAll("button[data-t]")) {
    b.classList.toggle("on", picked.dataset[b.dataset.a] !== "0");
  }
  const cine = isCinema(picked);
  const d = vidTb.querySelector('[data-a="delay"]');
  d.style.display = cine ? "" : "none";
  d.textContent = delayLabel(picked.dataset.delay || "2500");
  vidTb.querySelector('[data-a="sound"]').textContent = picked.dataset.sound === "0" ? "🔇 소리" : "🔊 소리";
  const light = picked.closest(".slide")?.dataset.peInk === "light";
  const ink = vidTb.querySelector('[data-a="ink"]');
  ink.classList.toggle("on", light);
  ink.textContent = light ? "글자 밝게" : "글자 어둡게";
  // 글이 영상 위에 얹히는 배치에서만 쓸모가 있다
  ink.style.display = OVERLAY_POS.has(picked.closest(".pe-imgzone")?.dataset.pos) ? "" : "none";
}

function removeVideo(slot) {
  snap();
  slot.querySelector(":scope > .pe-vbadge")?.remove();
  slot.querySelector("video")?.remove();
  slot.querySelector(".pe-vbar")?.remove();
  slot.querySelector(".pe-cap")?.remove();
  for (const k of ["autoplay", "loop", "sound", "delay", "poster", "fit"]) delete slot.dataset[k];
  slot.classList.add("pe-empty");
  unpickImage(); markDirty();
  toast("영상을 지웠습니다");
}

/* ───────────────────────── 영상 배치 고르기 패널 */
let vidChoice = null;
function openVidPane() {
  const s = curSlide();
  const zone = s.querySelector(".pe-imgzone");
  vidChoice = zone?.dataset.media === "video" ? s.dataset.peImg : null;
  const grid = $("#vidOpts");
  grid.innerHTML = VIDEO_PRESETS.map((p) => `
    <button class="pe-opt${p.id === vidChoice ? " on" : ""}" data-id="${p.id}">
      <span class="dg dark">${presetDiagram(p.id)}</span>
      <b>${p.name}</b><span>${p.hint}</span>
    </button>`).join("");
  grid.querySelectorAll(".pe-opt").forEach((b) => b.onclick = () => {
    vidChoice = b.dataset.id;
    grid.querySelectorAll(".pe-opt").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#vidClear").style.display = zone?.dataset.media === "video" ? "" : "none";
  $("#vidPaneSub").textContent =
    `${current + 1}번 슬라이드 · 배치를 고르면 영상 칸이 생깁니다. 소리는 항상 꺼진 채 시작합니다.`;
  $("#vidPane").classList.add("show");
}
function closeVidPane() { $("#vidPane").classList.remove("show"); }

function applyVidLayout(slideEl, presetId) {
  applyImgLayout(slideEl, presetId);
  const zone = slideEl.querySelector(".pe-imgzone");
  if (zone) zone.dataset.media = "video";
  // 글이 영상 위에 얹히면 검은 글씨는 읽히지 않는다 — 밝은 글자로 시작한다
  if (OVERLAY_POS.has(presetId)) slideEl.dataset.peInk = "light";
  else if (slideEl.dataset.peInk === "light") delete slideEl.dataset.peInk;
  paintVideoBadges();
}

$("#vidCancel").onclick = closeVidPane;
$("#vidGo").onclick = () => {
  if (!vidChoice) return toast("배치를 하나 고르세요");
  applyVidLayout(curSlide(), vidChoice);
  closeVidPane();
  const empty = curSlide().querySelector(".pe-slot.pe-empty");
  if (empty) fillVideoSlot(empty);                 // 바로 파일을 고르게 — 한 번 덜 누른다
  else toast("배치를 적용했습니다 — 빈 칸을 누르면 영상을 고를 수 있습니다");
};
$("#vidClear").onclick = () => { clearImgLayout(curSlide()); closeVidPane(); toast("영상 배치를 해제했습니다"); };
$("#vidPane").addEventListener("mousedown", (e) => { if (e.target.id === "vidPane") closeVidPane(); });

/* ───────────────────────── 글자 서식 (상단 바 + 떠오르는 툴바, 같은 엔진) */
let selTb = null;
function accentColor() {
  return doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue("--accent").trim() || "#E1361C";
}
function buildFmtBar() {
  const accent = accentColor();
  const ink = doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue("--ink").trim() || "#14150F";
  const sw = $("#fmtSwatches"); sw.innerHTML = "";
  for (const c of [accent, ink, "#FFFFFF"]) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="sw" style="background:${c}"></span>`;
    b.title = "이 색으로";
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.onclick = () => applyFormat("color", c);
    sw.appendChild(b);
  }
  $("#fmtbar").querySelectorAll("button[data-a]").forEach((b) => {
    b.addEventListener("pointerdown", (e) => e.preventDefault());   // iframe 선택 유지
    b.onclick = () => applyFormat(b.dataset.a, b.dataset.a === "hl" ? accentColor() : undefined);
  });
  const picker = $("#fmtColor");
  picker.addEventListener("pointerdown", (e) => e.stopPropagation());
  picker.addEventListener("input", () => applyFormat("color", picker.value));
}

function buildSelToolbar() {
  selTb = doc.createElement("div");
  selTb.className = "pe-seltb pe-ui";
  const accent = accentColor();
  const ink = doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue("--ink").trim() || "#14150F";
  selTb.innerHTML = `
    <button data-a="smaller">A−</button>
    <button data-a="bigger">A＋</button>
    <button data-a="bold"><b>B</b></button>
    <button data-a="color" data-v="${accent}"><span class="sw" style="background:${accent}"></span></button>
    <button data-a="color" data-v="${ink}"><span class="sw" style="background:${ink}"></span></button>
    <button data-a="hl" style="background:linear-gradient(transparent 55%, ${accent}44 55%)">가</button>
    <button data-a="clear">⌫</button>`;
  doc.body.appendChild(selTb);

  doc.addEventListener("selectionchange", () => {
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelTb();
    const r = sel.getRangeAt(0);
    const blockOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(TEXT_BLOCKS + "," + EXTRA_TEXT);
    const b1 = blockOf(r.startContainer), b2 = blockOf(r.endContainer);
    if (!b1 || b1 !== b2 || !b1.isContentEditable) return hideSelTb();
    const rect = r.getBoundingClientRect();
    selTb.style.display = "flex";
    selTb.style.left = Math.max(8, rect.left + rect.width / 2 - selTb.offsetWidth / 2) + "px";
    selTb.style.top = Math.max(8, rect.top - selTb.offsetHeight - 10) + "px";
  });
  selTb.addEventListener("mousedown", (e) => e.preventDefault());
  selTb.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    applyFormat(btn.dataset.a, btn.dataset.a === "hl" ? accentColor() : btn.dataset.v);
  });
}
function hideSelTb() { if (selTb) selTb.style.display = "none"; }

function applyFormat(action, value) {
  const sel = doc.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return toast("먼저 고칠 글자를 드래그로 선택하세요");
  const range = sel.getRangeAt(0);
  const blockOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(TEXT_BLOCKS + "," + EXTRA_TEXT);
  if (blockOf(range.startContainer) !== blockOf(range.endContainer))
    return toast("한 문단 안에서만 서식을 줄 수 있습니다");
  snap();

  const exactSpan = (() => {
    const n = range.commonAncestorContainer;
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (el?.tagName === "SPAN" && range.toString() === el.textContent) return el;
    if (el?.parentElement?.tagName === "SPAN" && range.toString() === el.parentElement.textContent) return el.parentElement;
    return null;
  })();

  const wrap = (styler) => {
    let target = exactSpan;
    if (!target) {
      target = doc.createElement("span");
      target.appendChild(range.extractContents());
      range.insertNode(target);
    }
    styler(target);
    sel.removeAllRanges();
    const nr = doc.createRange(); nr.selectNodeContents(target); sel.addRange(nr);
  };

  if (action === "bigger" || action === "smaller") {
    wrap((el) => {
      const cur = parseFloat(el.style.fontSize);
      const base = el.style.fontSize?.endsWith("em") && cur ? cur : 1;
      el.style.fontSize = Math.max(0.5, Math.min(3, base + (action === "bigger" ? 0.1 : -0.1))).toFixed(2).replace(/\.?0+$/, "") + "em";
    });
  }
  if (action === "color") wrap((el) => { el.style.color = value; });
  if (action === "hl") wrap((el) => { el.style.background = hexA(value || "#E1361C", .28); el.style.padding = "0 .08em"; });
  if (action === "bold") {
    const anc = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest("strong,b");
    if (anc) { const p = anc.parentNode; while (anc.firstChild) p.insertBefore(anc.firstChild, anc); anc.remove(); p.normalize(); }
    else { const st = doc.createElement("strong"); st.appendChild(range.extractContents()); range.insertNode(st); }
  }
  if (action === "clear") {
    const blockEl = blockOf(range.startContainer);
    const frag = range.extractContents();
    frag.querySelectorAll?.("span,strong,b,font")?.forEach((el) => {
      const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); el.remove();
    });
    range.insertNode(frag);
    blockEl?.normalize();
  }
  markDirty();
}
function hexA(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex);
  return m ? `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${a})` : hex;
}

/* ───────────────────────── 테마 교체 */
function buildThemeSelect() {
  const sel = $("#themeSel");
  myTemplate = doc.querySelector('meta[name="deck-template"]')?.content || null;
  sel.innerHTML = `<option value="">테마 바꾸기…</option>` +
    templates.map((t) => `<option value="${t.id}" ${t.id === myTemplate ? "selected" : ""}>${t.name}</option>`).join("");
  if (!myTemplate) { sel.disabled = true; sel.title = "이 덱은 맞춤 디자인이라 테마 교체가 안 됩니다"; }
  sel.onchange = async () => {
    const id = sel.value; if (!id || id === myTemplate) return;
    await save();
    const r = await (await fetch(`/api/decks/${encodeURIComponent(slug)}/theme`, { method: "POST",
      body: JSON.stringify({ templateId: id }) })).json();
    if (!r.ok) return toast(r.error || "테마 교체 실패");
    toast("테마를 바꿨습니다");
    location.reload();          // 무대 밖 CSS 가 바뀌었으니 새로 연다
  };
}


/* ───────────────────────── 되돌리기
 *
 * 브라우저 기본 undo 는 글자 입력만 되돌린다. 장을 지우거나 레이아웃을 갈아엎는 건
 * 손쓸 방법이 없었다 — 그래서 무대 전체를 스냅숏으로 쌓는다.
 * 구조를 바꾸는 동작은 전부 snap() 을 먼저 부르고, 글자 입력은 1.2초 쉴 때마다 한 장씩 남긴다.
 */
const UNDO_MAX = 50;
let undoStack = [], redoStack = [], snapTimer = null, restoring = false;

function paintUndo() {
  $("#btnUndo").disabled = !undoStack.length;
  $("#btnRedo").disabled = !redoStack.length;
}

/** 지금 상태를 되돌리기 더미에 올린다. 바꾸기 「직전」에 부른다. */
function snap() {
  if (restoring) return;
  clearTimeout(snapTimer);
  const html = stage().innerHTML;
  if (undoStack[undoStack.length - 1] === html) return;
  undoStack.push(html);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack = [];
  paintUndo();
}

/** 글자 입력용 — 잠깐 멈출 때마다 한 장. 매 글자마다 쌓으면 더미가 금세 찬다. */
function snapSoon() {
  if (restoring) return;
  clearTimeout(snapTimer);
  const before = stage().innerHTML;
  snapTimer = setTimeout(() => {
    if (undoStack[undoStack.length - 1] === before) return;
    undoStack.push(before);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack = [];
    paintUndo();
  }, 1200);
}

function restore(html) {
  restoring = true;
  clearTimeout(snapTimer);
  stage().innerHTML = html;
  picked = null;
  if (imgTb) { doc.body.appendChild(imgTb); imgTb.style.display = "none"; }
  hideBlockTb();
  ensureLayoutCss();
  enableEditing();
  rehydrateSlots();
  buildRail();
  show(Math.min(current, slides().length - 1));
  restoring = false;
  dirty = true;
  $("#saveStat").textContent = "수정됨…";
  $("#saveStat").classList.add("dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 2000);
  paintUndo();
}

function undo() {
  if (!undoStack.length) return toast("되돌릴 것이 없습니다");
  redoStack.push(stage().innerHTML);
  restore(undoStack.pop());
  toast("되돌렸습니다");
}
function redo() {
  if (!redoStack.length) return toast("다시 실행할 것이 없습니다");
  undoStack.push(stage().innerHTML);
  restore(redoStack.pop());
  toast("다시 실행했습니다");
}

$("#btnUndo").onclick = undo;
$("#btnRedo").onclick = redo;

/* ───────────────────────── 저장 */
function markDirty() {
  dirty = true;
  $("#saveStat").textContent = "수정됨…";
  $("#saveStat").classList.add("dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 2000);
  clearTimeout(window.__railT); window.__railT = setTimeout(buildRail, 800);
}

function cleanForSave() {
  const clone = stage().cloneNode(true);
  clone.querySelectorAll(".pe-ui,.pe-seltb,.pe-slidetb,.pe-imgtb").forEach((el) => el.remove());
  clone.querySelectorAll(".pe-picked").forEach((el) => el.classList.remove("pe-picked"));
  // 아무것도 안 들어간 칸은 편집기에서만 쓰는 안내다 — 발표·PDF 에 나가면 안 된다.
  clone.querySelectorAll(".pe-slot").forEach((el) => { if (!el.querySelector("img,video")) el.remove(); });
  // 편집기에서만 쓰던 흔적을 벗긴다 (컨트롤은 발표 장치가 새로 만든다)
  clone.querySelectorAll(".pe-vbar").forEach((el) => el.remove());
  clone.querySelectorAll(".pe-slot>video").forEach((v) => {
    v.removeAttribute("controls");
    v.pause?.();
    v.muted = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("preload", "auto");
  });
  clone.querySelectorAll(".pe-imgzone").forEach((z) => {
    if (z.querySelector(".pe-slot")) return;
    const sl = z.closest(".slide");
    z.remove();
    if (!sl) return;
    sl.removeAttribute("data-pe-img");              // 이미지가 하나도 없으면 원래 조판으로 되돌린다
    const box = sl.querySelector(":scope > .pe-bodybox");
    if (!box) return;
    box.classList.remove("pe-bodybox");
    if (!box.classList.contains("pe-bodywrap")) return;
    while (box.firstChild) sl.insertBefore(box.firstChild, box);
    box.remove();
  });
  clone.querySelectorAll(".pe-empty").forEach((el) => el.classList.remove("pe-empty"));
  clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  clone.querySelectorAll("[data-bound],[data-pe-guards]").forEach((el) => { el.removeAttribute("data-bound"); el.removeAttribute("data-pe-guards"); });
  const ss = clone.querySelectorAll(".slide");
  ss.forEach((s, i) => { s.classList.remove("active", "visible"); if (i === 0) s.classList.add("active", "visible"); });
  return clone.innerHTML;
}

async function save() {
  if (!dirty) return;
  clearTimeout(saveTimer);
  const body = { stageHtml: cleanForSave(), fingerprint: fp, title: $("#deckTitle").value.trim() };
  const res = await fetch(`/api/decks/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify(body) });
  const r = await res.json();
  if (res.status === 409) { toast("다른 창에서 먼저 저장했습니다. 새로고침 후 다시 열어 주세요."); return; }
  if (!r.ok) { toast(r.error || "저장 실패"); return; }
  fp = r.fingerprint; dirty = false;
  $("#saveStat").textContent = "저장됨";
  $("#saveStat").classList.remove("dirty");
}

$("#btnSave").onclick = () => { markDirty(); save(); };
$("#deckTitle").addEventListener("input", markDirty);
$("#btnPlay").onclick = async () => {
  curSlide();                                 // 덱 자체 네비게이션으로 넘겼어도 지금 보는 장 기준으로
  await save();
  window.open(`/decks/${encodeURIComponent(slug)}.html#s${current + 1}`, "_blank");
};
$("#btnPDF").onclick = async () => {
  await save();
  toast("인쇄 창이 뜨면 「PDF로 저장」을 고르세요");
  window.open(`/decks/${encodeURIComponent(slug)}.html?print=1`, "_blank");
};

/* ───────────────────────── AI 수정 */
$("#btnAI").onclick = () => { $("#aiPane").classList.toggle("show"); $("#aiText").focus(); };
$("#aiClose").onclick = () => $("#aiPane").classList.remove("show");

/* 두 갈래다.
 *  slide — 이 장의 innerHTML 만 AI 에게 주고 받아 DOM 에 꽂는다(기존 동작, 도구 없음).
 *  deck  — 서버가 자료를 읽고 파일을 직접 고친다. 장이 늘거나 줄 수 있어서 끝나면 새로고침. */
let researchDirs = [];
fetch("/api/ai-research").then((r) => r.json()).then((d) => { researchDirs = d.dirs || []; syncAiMode(); }).catch(() => {});

function syncAiMode() {
  const deck = $("#aiMode").value === "deck";
  $("#aiHint").textContent = deck
    ? (researchDirs.length
        ? `자료 ${researchDirs.length}곳을 읽고 고칩니다. 장 추가·삭제도 됩니다.`
        : "덱 전체를 읽고 고칩니다. 장 추가·삭제도 됩니다.")
    : "지금 보고 있는 장의 글과 표만 고칩니다.";
  $("#aiText").placeholder = deck
    ? "예: 5번 장의 내용을 표로 바꾸고, 뒤에 사례 소개 장을 2장 넣어줘"
    : "예: 제목을 더 강하게 / 불릿을 3개로 줄여줘";
}
$("#aiMode").onchange = syncAiMode;
syncAiMode();

$("#aiGo").onclick = async () => {
  const instruction = $("#aiText").value.trim();
  if (!instruction) return;
  if ($("#aiMode").value === "deck") return aiDeckEdit(instruction);

  const s = curSlide();
  $("#aiStat").textContent = "AI가 수정 중… (수십 초 걸립니다)";
  $("#aiGo").disabled = true;
  try {
    const r = await (await fetch("/api/ai-edit", { method: "POST",
      body: JSON.stringify({ slug, slideHtml: s.innerHTML, instruction }) })).json();
    if (!r.ok) { $("#aiStat").textContent = r.error || "실패"; return; }
    snap();
    s.innerHTML = r.html;
    enableEditing(); buildRail(); markDirty();
    $("#aiStat").textContent = "✓ 반영됨";
  } finally { $("#aiGo").disabled = false; }
};

async function aiDeckEdit(instruction) {
  // 서버는 디스크의 파일을 고친다. 저장 안 한 수정이 있으면 먼저 넘긴다 — 안 그러면 덮인다.
  if (dirty) { $("#aiStat").textContent = "저장 중…"; await save(); }

  $("#aiGo").disabled = true;
  $("#aiStat").textContent = "시작하는 중…";
  try {
    const start = await (await fetch("/api/ai-deck-edit", { method: "POST",
      body: JSON.stringify({ slug, instruction, index: current + 1 }) })).json();
    if (!start.jobId) { $("#aiStat").textContent = start.error || "시작 실패"; $("#aiGo").disabled = false; return; }

    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const j = await (await fetch(`/api/jobs/${start.jobId}`)).json();
      if (j.error && !j.status) { $("#aiStat").textContent = j.error; break; }

      if (j.status === "running") {
        $("#aiStat").textContent = `${j.phase}… ${j.elapsed}초${j.detail ? " · " + j.detail : ""}`;
        continue;
      }
      if (j.status === "error") {
        $("#aiStat").textContent = j.error || "실패";
        toast(j.error || "AI 수정에 실패했습니다.");
        break;
      }
      // done
      if (!j.applied?.length) {
        $("#aiStat").textContent = "바뀐 것 없음";
        toast(j.summary || "AI가 바꿀 것이 없다고 판단했습니다.");
        break;
      }
      $("#aiStat").textContent = `✓ ${j.applied.join(" · ")} — 총 ${j.slideCount}장`;
      toast(`${j.summary || "반영했습니다."} 다시 불러옵니다…`);
      setTimeout(() => location.reload(), 1800);
      return;
    }
  } catch (e) {
    $("#aiStat").textContent = "네트워크 오류";
  } finally { $("#aiGo").disabled = false; }
}
