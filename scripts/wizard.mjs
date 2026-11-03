#!/usr/bin/env node
// wizard.mjs — AI 에이전트(Codex 등)가 슬라이드 마법사를 다루는 명령어. 의존성 0.
// 사람용 설명은 AGENTS.md, 전체 명령은 `node scripts/wizard.mjs help`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listDecks, slugify, splitStage } from "../lib/deck-io.mjs";
import { SLIDE_CLASSES, SNIPPETS, assembleDeck, createDeckFromTemplate, listTemplates } from "../lib/templates.mjs";
import { setFolderMeta } from "../lib/folders.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECKS = join(ROOT, "decks");
const SECTION_RE = /<section class="slide[\s\S]*?<\/section>/g;

const HELP = `슬라이드 마법사 명령어

  node scripts/wizard.mjs start
      마법사를 켜고 주소를 알려 줌. 이미 켜져 있으면 주소만 알려 줌

  node scripts/wizard.mjs list
      만들어진 덱 목록

  node scripts/wizard.mjs templates
      디자인 템플릿 목록

  node scripts/wizard.mjs types [slide--list]
      슬라이드 유형과 HTML 예시

  node scripts/wizard.mjs new --title "제목" [--template swiss-red] [--folder "폴더"]
                              [--slides 슬라이드.html] [--css 덱전용.css]
      새 덱 만들기. --slides 가 없으면 기본 3장으로 시작

  node scripts/wizard.mjs check <덱이름>
      글자 넘침·잘림, 없는 이미지, 규칙 위반 검사 (문제가 있으면 종료 코드 1)

  node scripts/wizard.mjs shots <덱이름> [--only 3,7] [--out 폴더]
      슬라이드를 PNG 로 찍기. 기본 저장 위치는 .shots/<덱이름>/
`;

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

function deckFile(name) {
  if (!name) fail("덱 이름을 적어 주세요. 목록: node scripts/wizard.mjs list");
  const slug = name.replace(/\.html$/, "").replace(/^.*[\\/]/, "");
  const file = join(DECKS, `${slug}.html`);
  if (!existsSync(file)) fail(`덱이 없습니다: ${slug}`);
  return { slug, file };
}

/* ── 브라우저 (넘침 검사·캡처용) */
function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ...pf.flatMap((p) => [join(p, "Google/Chrome/Application/chrome.exe"), join(p, "Microsoft/Edge/Application/msedge.exe")]),
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  ];
  return candidates.find(existsSync) || null;
}

function runBrowser(browser, args) {
  const profile = mkdtempSync(join(tmpdir(), "slide-wizard-chrome-"));
  const r = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--force-device-scale-factor=1", "--window-size=1920,1080", `--user-data-dir=${profile}`, ...args,
  ], { encoding: "utf8", timeout: 90_000, maxBuffer: 256 * 1024 * 1024 });
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 지워지지 않아도 무해 */ }
  return r;
}

/* 브라우저 안에서 돌아 각 장의 넘침을 잰다. 무대 배율이 달라도 1920×1080 기준으로 환산한다. */
const MEASURE = `<script>
(async function(){
  await document.fonts.ready;
  var stage = document.getElementById('deckStage');
  var out = [];
  document.querySelectorAll('.slide').forEach(function(s, i){
    window.deck.showSlide(i);
    var sr = stage.getBoundingClientRect(), f = sr.width / 1920, problems = [];
    var label = function(el){
      var t = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
      return el.tagName.toLowerCase() + (el.className && el.className.baseVal === undefined && el.className ? '.' + String(el.className).split(' ')[0] : '') + (t ? ' 「' + t + '」' : '');
    };
    s.querySelectorAll('*').forEach(function(el){
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var x0 = (r.left - sr.left) / f, x1 = (r.right - sr.left) / f, y0 = (r.top - sr.top) / f, y1 = (r.bottom - sr.top) / f;
      var hasText = [].some.call(el.childNodes, function(n){ return n.nodeType === 3 && n.textContent.trim(); });
      if ((hasText || el.tagName === 'IMG') && (x0 < -2 || y0 < -2 || x1 > 1922 || y1 > 1082)) problems.push('화면 밖으로 나감: ' + label(el));
      if (el.matches('.body,.card,.shot') && el.scrollHeight > el.clientHeight + 3) problems.push('칸을 넘침(' + (el.scrollHeight - el.clientHeight) + 'px): ' + label(el));
      if (hasText && parseFloat(cs.fontSize) < 15) problems.push('글자가 너무 작음(' + cs.fontSize + '): ' + label(el));
      if (el.tagName === 'IMG' && el.complete && !el.naturalWidth) problems.push('이미지를 못 불러옴: ' + el.getAttribute('src'));
    });
    if (s.querySelector('.folio')) {
      var fr = s.querySelector('.folio').getBoundingClientRect();
      s.querySelectorAll('.body *').forEach(function(el){
        var hasText = [].some.call(el.childNodes, function(n){ return n.nodeType === 3 && n.textContent.trim(); });
        if (!hasText) return;
        var r = el.getBoundingClientRect();
        if (r.bottom > fr.top && r.top < fr.bottom && r.right > fr.left && r.left < fr.right) problems.push('쪽번호와 겹침: ' + label(el));
      });
    }
    if (problems.length) out.push({ slide: i + 1, problems: problems.slice(0, 5) });
  });
  var pre = document.createElement('pre');
  pre.id = '__wizard_result';
  pre.textContent = JSON.stringify({ slides: document.querySelectorAll('.slide').length, font: document.fonts.check('600 40px Pretendard'), issues: out });
  document.body.appendChild(pre);
})();
</script>`;

function checkStatic(stage, html) {
  const issues = [];
  const sections = stage.match(SECTION_RE) || [];
  if (!sections.length) issues.push("슬라이드가 하나도 없습니다");
  sections.forEach((s, i) => {
    const add = (m) => issues.push(`${i + 1}번 장: ${m}`);
    if (/<script|\son[a-z]+\s*=/i.test(s)) add("<script> 나 onclick 은 쓸 수 없습니다");
    if (/\s(?:src|href)=["']https?:/i.test(s)) add("외부 주소를 쓸 수 없습니다. 파일을 assets/<덱이름>/ 에 넣어 주세요");
    for (const m of s.matchAll(/<(?:img|video|source)[^>]+src="([^"]+)"/g)) {
      if (!m[1].startsWith("data:") && !existsSync(join(DECKS, decodeURI(m[1])))) add(`없는 파일: ${m[1]}`);
    }
    if ((s.match(/<section/g) || []).length !== 1) add("<section> 이 겹쳐 있습니다");
  });
  const open = (stage.match(/<section[\s>]/g) || []).length;
  if (open !== sections.length) issues.push(`<section> 짝이 맞지 않습니다 (${sections.length}/${open})`);
  if (!/<title>[^<]+<\/title>/.test(html)) issues.push("<title> 이 없습니다");
  return { issues, count: sections.length };
}

function cmdCheck(o) {
  const { slug, file } = deckFile(o._[0]);
  const html = readFileSync(file, "utf8");
  const { issues, count } = checkStatic(splitStage(html).stage, html);

  const browser = findBrowser();
  let rendered = null, note = "";
  if (!browser) note = "브라우저를 찾지 못해 글자 넘침은 검사하지 못했습니다 (Chrome·Edge 설치 필요)";
  else {
    const tmp = mkdtempSync(join(tmpdir(), "slide-wizard-check-"));
    const page = join(tmp, "check.html");
    const base = `<base href="${pathToFileURL(DECKS)}/">`;
    writeFileSync(page, html.replace(/<head([^>]*)>/, `<head$1>${base}`).replace(/<\/body>(?![\s\S]*<\/body>)/, `${MEASURE}</body>`));
    const r = runBrowser(browser, ["--virtual-time-budget=6000", "--dump-dom", pathToFileURL(page).href]);
    rmSync(tmp, { recursive: true, force: true });
    const m = (r.stdout || "").match(/<pre id="__wizard_result">([\s\S]*?)<\/pre>/);
    if (m) rendered = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    else note = "브라우저 검사를 실행하지 못했습니다. 샌드박스 안이라면 사용자 승인을 받아 다시 실행하세요";
  }

  for (const it of rendered?.issues || []) for (const p of it.problems) issues.push(`${it.slide}번 장: ${p}`);
  if (rendered && !rendered.font) note = "Pretendard 글꼴이 적용되지 않았습니다";

  console.log(`덱: ${slug} (${count}장)`);
  if (note) console.log(`⚠️  ${note}`);
  if (issues.length) {
    console.log(`❌ 고칠 것 ${issues.length}개`);
    for (const i of issues) console.log(`  - ${i}`);
    process.exit(1);
  }
  console.log(rendered ? "✅ 문제 없음 (브라우저 검사 포함)" : "✅ 파일 검사 통과. 넘침 검사는 하지 못했습니다");
  if (!rendered) process.exit(2);
}

function cmdShots(o) {
  const { slug, file } = deckFile(o._[0]);
  const browser = findBrowser();
  if (!browser) fail("브라우저를 찾지 못했습니다 (Chrome·Edge 설치 필요)");
  const count = (splitStage(readFileSync(file, "utf8")).stage.match(SECTION_RE) || []).length;
  const only = typeof o.only === "string" ? o.only.split(",").map(Number).filter((n) => n >= 1 && n <= count) : Array.from({ length: count }, (_, i) => i + 1);
  const out = resolve(typeof o.out === "string" ? o.out : join(ROOT, ".shots", slug));
  mkdirSync(out, { recursive: true });
  let failed = 0;
  for (const n of only) {
    const png = join(out, `slide-${String(n).padStart(2, "0")}.png`);
    rmSync(png, { force: true });
    runBrowser(browser, ["--virtual-time-budget=3000", `--screenshot=${png}`, `${pathToFileURL(file).href}#s${n}`]);
    if (existsSync(png)) console.log(png); else { failed++; console.error(`❌ ${n}번 장을 찍지 못했습니다`); }
  }
  if (failed) process.exit(1);
}

function cmdNew(o) {
  if (typeof o.title !== "string" || !o.title.trim()) fail('--title "제목" 이 필요합니다');
  const templateId = typeof o.template === "string" ? o.template : "swiss-red";
  if (!listTemplates(ROOT).some((t) => t.id === templateId)) fail(`없는 템플릿: ${templateId}`);
  const title = o.title.trim();
  let slug = slugify(title);
  for (let n = 2; existsSync(join(DECKS, `${slug}.html`)); n++) slug = `${slugify(title)}-${n}`;

  let html;
  if (typeof o.slides === "string") {
    let slides = readFileSync(resolve(o.slides), "utf8");
    if (!(slides.match(SECTION_RE) || []).length) fail('--slides 파일에 <section class="slide ..."> 이 없습니다');
    if (typeof o.css === "string") slides = `<style id="deck-extra-css">\n${readFileSync(resolve(o.css), "utf8")}\n</style>\n${slides}`;
    html = assembleDeck(ROOT, templateId, title, slides);
  } else {
    html = createDeckFromTemplate(ROOT, templateId, title);
  }
  if (typeof o.folder === "string") html = setFolderMeta(html, o.folder);
  mkdirSync(DECKS, { recursive: true });
  writeFileSync(join(DECKS, `${slug}.html`), html, "utf8");
  console.log(`✅ 만들었습니다: decks/${slug}.html`);
  console.log(`다음: node scripts/wizard.mjs check ${JSON.stringify(slug)}`);
  console.log(`편집: <마법사 주소>/editor?deck=${encodeURIComponent(slug)}`);
}

/* 4900 에 다른 프로그램이 있으면 다음 포트를 쓴다. /api/engine 이 답하면 마법사다. */
async function isWizard(port) {
  try {
    const r = await fetch(`http://localhost:${port}/api/engine`, { signal: AbortSignal.timeout(800) });
    return r.ok && "id" in await r.json();
  } catch { return false; }
}
async function isFree(port) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) }); return false; }
  catch (e) { return e.cause?.code === "ECONNREFUSED" || e.cause?.code === "ENOTFOUND"; }
}

async function cmdStart() {
  for (let port = 4900; port <= 4905; port++) {
    if (await isWizard(port)) return console.log(`✅ 이미 켜져 있어요: http://localhost:${port}/`);
    if (!(await isFree(port))) continue;
    const child = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(port)], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 25; i++) {
      await new Promise((ok) => setTimeout(ok, 200));
      if (await isWizard(port)) return console.log(`✅ 켰어요: http://localhost:${port}/`);
    }
    fail("서버가 켜지지 않았습니다. 샌드박스 안이라면 사용자 승인을 받아 다시 실행하세요");
  }
  fail("4900~4905 포트가 모두 사용 중입니다");
}

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
switch (cmd) {
  case "list":
    for (const d of listDecks(DECKS)) console.log(`${d.slug}\t${d.slideCount}장\t${d.folder || "미분류"}\t${d.title}`);
    break;
  case "templates":
    for (const t of listTemplates(ROOT)) console.log(`${t.id}\t${t.name}\t${t.description}`);
    break;
  case "types":
    for (const c of o._[0] ? [o._[0]] : SLIDE_CLASSES) {
      if (!SNIPPETS[c]) fail(`없는 유형: ${c}`);
      console.log(`<!-- ${c} -->\n${SNIPPETS[c]}\n`);
    }
    break;
  case "start": await cmdStart(); break;
  case "new": cmdNew(o); break;
  case "check": cmdCheck(o); break;
  case "shots": cmdShots(o); break;
  case undefined: case "help": case "--help": console.log(HELP); break;
  default: fail(`모르는 명령: ${cmd}\n\n${HELP}`);
}
