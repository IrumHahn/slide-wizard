/* 갤러리 — 목록·썸네일·생성(빈 덱/AI)·복제·삭제 */
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show");
  clearTimeout(window.__tt); window.__tt = setTimeout(() => t.classList.remove("show"), 2400); };

let templates = [];
let pickedTpl = "swiss-red";
let aiMode = true;

/* ── 폴더 상태. 현재 폴더는 URL 해시(#f=이름)에 둔다 — 새로고침·뒤로가기에 살아남는다.
   ALL = 전체, "" = 미분류 */
const ALL = "*";
let allDecks = [];
let folderInfo = { folders: [], unfiled: 0, total: 0 };
function curFolder() {
  const m = location.hash.match(/^#f=(.*)$/);
  return m ? decodeURIComponent(m[1]) : ALL;
}
function setFolder(f) { location.hash = f === ALL ? "" : "#f=" + encodeURIComponent(f); }
const folderLabel = (f) => f === ALL ? "전체" : f === "" ? "미분류" : f;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

async function api(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/* 왼쪽 폴더 목록 */
function renderFolders() {
  const cur = curFolder();
  const box = $("#folderList"); box.innerHTML = "";
  const item = (key, name, count, cls = "") => {
    const el = document.createElement("div");
    el.className = "fitem " + cls + (cur === key ? " on" : "");
    el.innerHTML = `<span class="nm">${esc(name)}</span><span class="c">${count}</span>`;
    el.onclick = () => setFolder(key);
    // 카드를 끌어다 놓으면 이동
    el.ondragover = (e) => { if (key !== ALL) { e.preventDefault(); el.classList.add("drop"); } };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = async (e) => {
      e.preventDefault(); el.classList.remove("drop");
      const slug = e.dataTransfer.getData("text/deck");
      if (slug && key !== ALL) await moveDeck(slug, key);
    };
    box.appendChild(el);
  };
  item(ALL, "전체", folderInfo.total);
  for (const f of folderInfo.folders) item(f.name, f.name, f.count);
  item("", "미분류", folderInfo.unfiled, "sep");

  // 머리글
  $("#curName").textContent = folderLabel(cur);
  const n = cur === ALL ? folderInfo.total : cur === "" ? folderInfo.unfiled
    : (folderInfo.folders.find((f) => f.name === cur) || { count: 0 }).count;
  $("#curCount").textContent = n + "개";
  const real = cur !== ALL && cur !== "";
  $("#btnRenameFolder").style.display = real ? "" : "none";
  $("#btnDeleteFolder").style.display = real ? "" : "none";

  // 새 덱 모달의 폴더 선택
  const sel = $("#fFolder");
  sel.innerHTML = `<option value="">미분류</option>` +
    folderInfo.folders.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("");
  sel.value = real ? cur : "";
}

async function moveDeck(slug, folder) {
  try {
    await api(`/api/decks/${encodeURIComponent(slug)}/folder`, { method: "PUT", body: JSON.stringify({ folder }) });
    toast(folder ? `「${folder}」로 옮겼습니다` : "미분류로 옮겼습니다");
    loadDecks();
  } catch (e) { toast("이동 실패: " + e.message); }
}

/* 폴더 이동 모달 */
function openMove(d) {
  $("#mvHint").textContent = `「${d.title}」`;
  const list = $("#mvList"); list.innerHTML = "";
  const opt = (folder, label, cls = "") => {
    const b = document.createElement("button");
    b.className = cls + (d.folder === folder ? " on" : "");
    b.textContent = label;
    b.onclick = async () => { $("#mvBg").classList.remove("show"); if (d.folder !== folder) await moveDeck(d.slug, folder); };
    list.appendChild(b);
  };
  for (const f of folderInfo.folders) opt(f.name, f.name);
  opt("", "미분류");
  const nb = document.createElement("button");
  nb.className = "new"; nb.textContent = "+ 새 폴더에 넣기…";
  nb.onclick = async () => {
    const name = prompt("새 폴더 이름");
    if (!name || !name.trim()) return;
    $("#mvBg").classList.remove("show");
    await moveDeck(d.slug, name.trim());
  };
  list.appendChild(nb);
  $("#mvBg").classList.add("show");
}
$("#mvCancel").onclick = () => $("#mvBg").classList.remove("show");

$("#btnNewFolder").onclick = async () => {
  const name = prompt("새 폴더 이름");
  if (!name || !name.trim()) return;
  try { const r = await api("/api/folders", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    toast(r.existed ? "이미 있는 폴더입니다" : "폴더를 만들었습니다"); setFolder(r.name); loadDecks(); }
  catch (e) { toast("실패: " + e.message); }
};
$("#btnRenameFolder").onclick = async () => {
  const cur = curFolder();
  const name = prompt("폴더 이름 바꾸기", cur);
  if (!name || !name.trim() || name.trim() === cur) return;
  try { await api(`/api/folders/${encodeURIComponent(cur)}`, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
    toast("이름을 바꿨습니다"); setFolder(name.trim()); loadDecks(); }
  catch (e) { toast("실패: " + e.message); }
};
$("#btnDeleteFolder").onclick = async () => {
  const cur = curFolder();
  if (!confirm(`폴더 「${cur}」를 지울까요?\n(덱은 지워지지 않고 미분류로 옮겨집니다)`)) return;
  try { await api(`/api/folders/${encodeURIComponent(cur)}`, { method: "DELETE" });
    toast("폴더를 지웠습니다"); setFolder(ALL); loadDecks(); }
  catch (e) { toast("실패: " + e.message); }
};
addEventListener("hashchange", renderDecks);
async function loadTemplates() {
  templates = await (await fetch("/api/templates")).json();
  const box = $("#tplPick"); box.innerHTML = "";
  for (const t of templates) {
    const el = document.createElement("div");
    el.className = "tp" + (t.id === pickedTpl ? " on" : "");
    el.innerHTML = `<div class="sw">
        <i style="background:${t.tokens.paper}"></i>
        <i style="background:${t.tokens.ink}"></i>
        <i style="background:${t.tokens.accent}"></i>
      </div><b>${t.name}</b><p>${t.description || ""}</p>`;
    el.onclick = () => { pickedTpl = t.id; box.querySelectorAll(".tp").forEach((x) => x.classList.remove("on")); el.classList.add("on"); };
    box.appendChild(el);
  }
}

function fmtDate(ms) {
  const d = new Date(ms), now = Date.now(), day = 864e5;
  const diff = Math.floor((now - ms) / day);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  if (diff < 30) return `${diff}일 전`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

/* 썸네일: 첫 슬라이드를 미니 무대로 감싼 srcdoc iframe. base 를 /decks/ 로
   잡아야 슬라이드 안 상대경로 이미지(lecture-assets/…)가 산다. */
function thumbSrcdoc(thumb) {
  return `<!DOCTYPE html><html><head><base href="/decks/"><style>${thumb.css}
  html,body{margin:0;overflow:hidden}
  .slide{position:absolute;inset:0;width:1920px;height:1080px;visibility:visible!important;opacity:1!important}
  .reveal{opacity:1!important;transform:none!important}
  </style></head><body>${thumb.slide}</body></html>`;
}

async function loadDecks() {
  const [decks, folders] = await Promise.all([
    (await fetch("/api/decks")).json(),
    (await fetch("/api/folders")).json().catch(() => null),
  ]);
  allDecks = decks.map((d) => ({ ...d, folder: d.folder || "" }));
  // 폴더 API 가 없는 환경(옛 웹)에서는 덱에서 폴더를 추린다
  folderInfo = folders && folders.folders ? folders : (() => {
    const m = new Map(); let unfiled = 0;
    for (const d of allDecks) d.folder ? m.set(d.folder, (m.get(d.folder) || 0) + 1) : unfiled++;
    return { folders: [...m].map(([name, count]) => ({ name, count })), unfiled, total: allDecks.length };
  })();
  renderDecks();
}

function renderDecks() {
  renderFolders();
  const cur = curFolder();
  const decks = allDecks.filter((d) => cur === ALL || d.folder === cur);
  const grid = $("#grid"); grid.innerHTML = "";
  $("#empty").style.display = decks.length ? "none" : "block";
  $("#empty").textContent = allDecks.length ? "이 폴더에는 발표자료가 없습니다. 카드의 「폴더」 버튼이나 끌어다 놓기로 옮길 수 있습니다."
    : "아직 발표자료가 없습니다. 「AI로 만들기」로 시작해 보세요.";
  for (const d of decks) {
    const card = document.createElement("div");
    card.className = "dcard";
    card.draggable = true;
    card.ondragstart = (e) => { e.dataTransfer.setData("text/deck", d.slug); card.classList.add("dragging"); };
    card.ondragend = () => card.classList.remove("dragging");
    card.innerHTML = `
      <div class="thumb"></div>
      <div class="meta">
        <div class="t">${esc(d.title)}</div>
        <div class="s">${d.slideCount}장 · ${fmtDate(d.mtime)}</div>
        ${cur === ALL ? `<div class="f">📁 ${esc(folderLabel(d.folder))}</div>` : ""}
      </div>
      <div class="acts">
        <button data-a="edit">편집</button>
        <button data-a="play">발표</button>
        <button data-a="pdf">PDF</button>
        <button data-a="dup">복제</button>
        <button data-a="move" title="폴더로 이동">폴더</button>
        <span style="flex:1"></span>
        <button data-a="del" class="danger">삭제</button>
      </div>`;
    const th = card.querySelector(".thumb");
    const ifr = document.createElement("iframe");
    ifr.loading = "lazy";
    ifr.srcdoc = thumbSrcdoc(d.thumb);
    th.appendChild(ifr);
    const fit = () => { const w = th.clientWidth || 300; ifr.style.transform = `scale(${w / 1920})`; };
    requestAnimationFrame(fit); addEventListener("resize", fit);

    const open = () => location.href = `/editor?deck=${encodeURIComponent(d.slug)}`;
    th.onclick = open;
    card.querySelector(".t").onclick = open;
    card.querySelector('[data-a=edit]').onclick = open;
    card.querySelector('[data-a=play]').onclick = () => window.open(`/decks/${encodeURIComponent(d.slug)}.html`, "_blank");
    card.querySelector('[data-a=pdf]').onclick = () => window.open(`/decks/${encodeURIComponent(d.slug)}.html?print=1`, '_blank');
    card.querySelector('[data-a=move]').onclick = () => openMove(d);
    card.querySelector('[data-a=dup]').onclick = async () => {
      await fetch(`/api/decks/${encodeURIComponent(d.slug)}/duplicate`, { method: "POST" });
      toast("복제했습니다"); loadDecks();
    };
    card.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`「${d.title}」을 삭제할까요?\n(휴지통 decks/.trash 에 보관됩니다)`)) return;
      await fetch(`/api/decks/${encodeURIComponent(d.slug)}`, { method: "DELETE" });
      toast("휴지통으로 보냈습니다"); loadDecks();
    };
    grid.appendChild(card);
  }
}

/* ── 새 덱 모달 */
function openModal(ai) {
  aiMode = ai;
  $("#mkTitle").textContent = ai ? "AI로 발표자료 만들기" : "빈 덱 만들기";
  $("#mkHint").textContent = ai ? "주제와 재료를 주면 개요를 짜고 슬라이드를 만들어 갤러리에 넣습니다."
    : "표지·장구분·목록 3장으로 시작합니다.";
  $("#aiFields").style.display = ai ? "" : "none";
  $("#jobBox").style.display = "none";
  $("#mkGo").disabled = false;
  const cf = curFolder(); $("#fFolder").value = (cf !== ALL && cf !== "") ? cf : "";
  $("#mkBg").classList.add("show");
  $("#fTitle").focus();
}
$("#btnAI").onclick = async () => {
  openModal(true);
  const box = $("#engineHint");
  box.textContent = "";
  try {
    const e = await api("/api/engine");
    if (e.id) box.textContent = `${e.label}가 만듭니다. 15장에 2~3분쯤 걸려요.`;
    else box.innerHTML = '아직 Codex를 찾지 못했어요. <a href="/guide/#ready" target="_blank">가이드의 준비물</a>을 먼저 봐 주세요.';
  } catch { /* 안내만 빠진다 */ }
};
$("#btnBlank").onclick = () => openModal(false);
$("#mkCancel").onclick = () => $("#mkBg").classList.remove("show");

$("#mkGo").onclick = async () => {
  const title = $("#fTitle").value.trim();
  if (!title) return toast("제목을 적어 주세요");
  if (!aiMode) {
    const r = await (await fetch("/api/decks", { method: "POST", body: JSON.stringify({ title, templateId: pickedTpl, folder: $("#fFolder").value }) })).json();
    location.href = `/editor?deck=${encodeURIComponent(r.slug)}`;
    return;
  }
  const topic = $("#fTopic").value.trim();
  if (!topic) return toast("주제를 적어 주세요");
  $("#mkGo").disabled = true;
  $("#jobBox").style.display = "";
  let jobId;
  try {
    ({ jobId } = await api("/api/generate", { method: "POST",
      body: JSON.stringify({ title, topic, materials: $("#fMaterials").value, templateId: pickedTpl, slideCount: $("#fCount").value, folder: $("#fFolder").value }) }));
  } catch (e) {
    $("#jobPhase").textContent = "실패: " + e.message;
    $("#mkGo").disabled = false;
    return;
  }
  const poll = setInterval(async () => {
    const j = await (await fetch(`/api/jobs/${jobId}`)).json();
    $("#jobPhase").textContent = j.phase + (j.status === "running" ? ` · ${j.elapsed}초` : "");
    $("#jobDetail").textContent = j.detail || "";
    if (j.status === "done") {
      clearInterval(poll);
      toast("완성! 편집기로 이동합니다");
      setTimeout(() => location.href = `/editor?deck=${encodeURIComponent(j.slug)}`, 700);
    }
    if (j.status === "error") {
      clearInterval(poll);
      $("#jobPhase").textContent = "실패: " + (j.error || "");
      $("#mkGo").disabled = false;
    }
  }, 1500);
};

loadTemplates();
loadDecks();

/* ── 갤러리에도 PDF 버튼 */
