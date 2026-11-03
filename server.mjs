#!/usr/bin/env node
// server.mjs — 「한이룸의 슬라이드 마법사」 로컬 서버
//
//   실행:  node server.mjs        (기본 http://localhost:4900)
//   종료:  Ctrl+C
//
// 로컬 전용. 127.0.0.1 에만 바인드. 의존성 0.
// 덱 = decks/*.html (자체 완결 — 서버 없이 파일만 열어도 발표됨)

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, createWriteStream, createReadStream, statSync } from "node:fs";
import { join, resolve, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { listDecks, readDeck, writeStage, extractThumb, slugify, fingerprint, splitStage } from "./lib/deck-io.mjs";
import { createDeckFromTemplate, listTemplates, assembleDeck, SLIDE_CLASSES } from "./lib/templates.mjs";
import { startGenerateJob, getJob, aiEditSlide } from "./lib/jobs.mjs";
import { startDeckEditJob, getDeckEditJob, loadResearchConfig } from "./lib/deck-edit.mjs";
import { currentEngine } from "./lib/ai-engine.mjs";
import { ensureVideoRuntime } from "./lib/video-runtime.mjs";
import { listFolders, createFolder, renameFolder, deleteFolder, setDeckFolder, setFolderMeta, cleanFolderName } from "./lib/folders.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DECKS = join(ROOT, "decks");
const ASSETS = join(ROOT, "assets");
const APP = join(ROOT, "app");
const GUIDE = join(ROOT, "docs");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg("--port", process.env.PRESENT_PORT || "4900"));

mkdirSync(DECKS, { recursive: true });
mkdirSync(ASSETS, { recursive: true });

// ── 썸네일 캐시 (mtime 이 바뀌면 다시 만든다)
const thumbCache = new Map();
function thumbFor(slug) {
  const file = join(DECKS, `${slug}.html`);
  const d = readDeck(file);
  const hit = thumbCache.get(slug);
  if (hit && hit.mtime === d.mtime) return hit.thumb;
  const thumb = extractThumb(d.html);
  thumbCache.set(slug, { mtime: d.mtime, thumb });
  return thumb;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".mov"]);
const VIDEO_LIMIT = 300 * 1024 * 1024;   // 300MB

function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((ok, no) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { no(new Error("too-large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", no);
  });
}
function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  if (!p.startsWith(base)) return null;
  return p;
}
const okSlug = (s) => /^[\w가-힣.-]+$/.test(s);
const deckFiles = () => readdirSync(DECKS).filter((f) => f.endsWith(".html")).map((f) => join(DECKS, f));

/** 덱 파일에 발표용 영상 장치를 최신으로 꽂아 둔다.
 *  파일을 그대로 더블클릭해도 영상이 돌아야 하므로 파일에 직접 쓴다. */
function syncVideoRuntime(file) {
  try {
    const html = readFileSync(file, "utf8");
    const { html: next, changed } = ensureVideoRuntime(html);
    if (changed) writeFileSync(file, next, "utf8");
    return changed;
  } catch { return false; }
}

/** 영상은 통째로 보내면 안 된다 — 탐색(Range)도 안 되고 메모리도 먹는다. */
function sendVideo(req, res, file, type) {
  const { size } = statSync(file);
  const range = req.headers.range;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (!m) {
    res.writeHead(200, { ...head, "Content-Length": size });
    return createReadStream(file).pipe(res);
  }
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (!(start >= 0) || start >= size || end >= size || start > end) {
    res.writeHead(416, { ...head, "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalRequest(req) {
  const hostOf = (h) => h.replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host || ""))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return LOCAL_HOSTS.has(new URL(origin).hostname); } catch { return false; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  // 다른 웹사이트가 이 서버로 몰래 요청을 보내 덱을 지우거나 AI 를 돌리지 못하게 막는다.
  if (!isLocalRequest(req)) return send(res, 403, { error: "이 컴퓨터의 브라우저에서만 쓸 수 있어요" });
  try {
    // ───────── API
    if (path === "/api/decks" && req.method === "GET") {
      const decks = listDecks(DECKS).map((d) => ({ ...d, thumb: thumbFor(d.slug) }));
      return send(res, 200, decks);
    }

    if (path === "/api/decks" && req.method === "POST") {
      const { title, templateId, folder } = JSON.parse(await readBody(req));
      if (!title) return send(res, 400, { error: "title 필요" });
      let slug = slugify(title); let n = 2;
      while (existsSync(join(DECKS, `${slug}.html`))) slug = `${slugify(title)}-${n++}`;
      const html = setFolderMeta(createDeckFromTemplate(ROOT, templateId || "swiss-red", title), folder);
      writeFileSync(join(DECKS, `${slug}.html`), html, "utf8");
      return send(res, 200, { slug, folder: cleanFolderName(folder) });
    }

    // ───────── 폴더 (가상 — 덱 head 의 deck-folder 메타 + config/folders.json)
    if (path === "/api/folders" && req.method === "GET")
      return send(res, 200, listFolders(ROOT, listDecks(DECKS)));
    if (path === "/api/folders" && req.method === "POST") {
      const { name } = JSON.parse(await readBody(req));
      try { return send(res, 200, createFolder(ROOT, name)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    const mFolder = path.match(/^\/api\/folders\/([^/]+)$/);
    if (mFolder && req.method === "PUT") {
      const { name } = JSON.parse(await readBody(req));
      try { const r = renameFolder(ROOT, deckFiles(), mFolder[1], name); thumbCache.clear(); return send(res, 200, r); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (mFolder && req.method === "DELETE") {
      const r = deleteFolder(ROOT, deckFiles(), mFolder[1]); thumbCache.clear();
      return send(res, 200, r);
    }
    const mMove = path.match(/^\/api\/decks\/([^/]+)\/folder$/);
    if (mMove && req.method === "PUT") {
      const slug = mMove[1];
      if (!okSlug(slug)) return send(res, 400, { error: "잘못된 이름" });
      const file = join(DECKS, `${slug}.html`);
      if (!existsSync(file)) return send(res, 404, { error: "없는 덱" });
      const { folder } = JSON.parse(await readBody(req));
      const name = cleanFolderName(folder);
      if (name) createFolder(ROOT, name);          // 처음 보는 이름이면 폴더도 만든다
      setDeckFolder(file, name);
      return send(res, 200, { ok: true, folder: name });
    }

    const mDeck = path.match(/^\/api\/decks\/([^/]+)$/);
    if (mDeck) {
      const slug = mDeck[1];
      if (!okSlug(slug)) return send(res, 400, { error: "잘못된 이름" });
      const file = join(DECKS, `${slug}.html`);
      if (!existsSync(file)) return send(res, 404, { error: "없는 덱" });

      if (req.method === "GET") {
        const d = readDeck(file);
        return send(res, 200, { slug: d.slug, title: d.title, folder: d.folder, slideCount: d.slideCount, fingerprint: d.fingerprint });
      }
      if (req.method === "PUT") {
        const { stageHtml, fingerprint: fp, title } = JSON.parse(await readBody(req));
        if (typeof stageHtml !== "string" || !stageHtml.includes('<section class="slide'))
          return send(res, 400, { error: "무대 HTML 이 아님" });
        const r = writeStage(file, stageHtml, fp, join(DECKS, ".history", slug));
        if (!r.ok) return send(res, 409, { error: "다른 곳에서 먼저 저장됨", fingerprint: r.fingerprint });
        if (title) { // 제목 갱신
          let html = readFileSync(file, "utf8");
          html = html.replace(/<title>.*?<\/title>/s, `<title>${title}</title>`);
          writeFileSync(file, html, "utf8");
        }
        syncVideoRuntime(file);        // 영상 장치를 최신본으로
        thumbCache.delete(slug);
        return send(res, 200, { ok: true, fingerprint: r.fingerprint });
      }
      if (req.method === "DELETE") {
        // 지우지 않고 휴지통으로
        mkdirSync(join(DECKS, ".trash"), { recursive: true });
        copyFileSync(file, join(DECKS, ".trash", `${Date.now()}-${slug}.html`));
        rmSync(file);
        thumbCache.delete(slug);
        return send(res, 200, { ok: true });
      }
    }

    const mTheme = path.match(/^\/api\/decks\/([^/]+)\/theme$/);
    if (mTheme && req.method === "POST") {
      const slug = mTheme[1];
      const file = join(DECKS, `${slug}.html`);
      if (!existsSync(file)) return send(res, 404, { error: "없는 덱" });
      const { templateId } = JSON.parse(await readBody(req));
      const d = readDeck(file);
      // 테마 교체는 공용 어휘(slide--*)로 만든 덱만 된다.
      // 맞춤 CSS 덱은 스타일이 슬라이드에 새겨져 있어 교체 불가.
      const hasMeta = /<meta name="deck-template"/.test(d.html);
      const sections = [...d.stageHtml.matchAll(/<section class="slide ([^"]*)"/g)];
      const vocabOk = sections.length > 0 && sections.every((m) =>
        m[1].split(/\s+/).some((c) => SLIDE_CLASSES.includes(c)));
      if (!hasMeta && !vocabOk)
        return send(res, 400, { error: "이 덱은 맞춤 디자인이라 테마를 바꿀 수 없습니다" });
      // 활성 상태를 벗기고 새 옷으로 재조립
      const cleanStage = d.stageHtml.replace(/class="slide active visible /g, 'class="slide ')
        .replace(/ class="slide (.*?)\bactive\b ?/g, ' class="slide $1')
        .replace(/\bvisible\b ?/g, "");
      const html = setFolderMeta(assembleDeck(ROOT, templateId, d.title, cleanStage), d.folder); // 폴더는 유지
      // .history 보관 후 통째로 교체 (무대 밖 CSS 가 바뀌므로 writeStage 로는 안 된다)
      const hist = join(DECKS, ".history", slug);
      mkdirSync(hist, { recursive: true });
      copyFileSync(file, join(hist, `${new Date().toISOString().replace(/[:.]/g, "-")}-theme.html`));
      writeFileSync(file, html, "utf8");
      syncVideoRuntime(file);
      thumbCache.delete(slug);
      const nd = readDeck(file);
      return send(res, 200, { ok: true, fingerprint: nd.fingerprint });
    }

    const mDup = path.match(/^\/api\/decks\/([^/]+)\/duplicate$/);
    if (mDup && req.method === "POST") {
      const slug = mDup[1];
      const file = join(DECKS, `${slug}.html`);
      if (!existsSync(file)) return send(res, 404, { error: "없는 덱" });
      let copy = `${slug}-사본`; let n = 2;
      while (existsSync(join(DECKS, `${copy}.html`))) copy = `${slug}-사본-${n++}`;
      let html = readFileSync(file, "utf8");
      html = html.replace(/<title>(.*?)<\/title>/s, (m, t) => `<title>${t} (사본)</title>`);
      writeFileSync(join(DECKS, `${copy}.html`), html, "utf8");
      return send(res, 200, { slug: copy });
    }

    const mAsset = path.match(/^\/api\/assets\/([^/]+)$/);
    if (mAsset && req.method === "POST") {
      const slug = mAsset[1];
      if (!okSlug(slug)) return send(res, 400, { error: "잘못된 이름" });
      const { name, dataUrl } = JSON.parse(await readBody(req));
      const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/s.exec(dataUrl || "");
      if (!m) return send(res, 400, { error: "이미지 dataUrl 필요" });
      const ext = m[2] === "jpeg" ? "jpg" : m[2];
      const dir = join(ASSETS, slug); mkdirSync(dir, { recursive: true });
      const fname = `img-${Date.now()}.${ext}`;
      writeFileSync(join(dir, fname), Buffer.from(m[3], "base64"));
      // 덱은 decks/ 아래 있으므로 상대경로는 ../assets/…
      return send(res, 200, { url: `../assets/${slug}/${fname}`, name: name || fname });
    }

    // ───────── 영상 올리기
    //  이미지처럼 dataUrl(base64) 로 받으면 300MB 가 400MB 문자열이 되어 메모리에서 터진다.
    //  파일 바이트를 그대로 흘려보내고, 서버는 받는 대로 디스크에 쓴다.
    const mVideo = path.match(/^\/api\/videos\/([^/]+)$/);
    if (mVideo && req.method === "POST") {
      const slug = mVideo[1];
      if (!okSlug(slug)) return send(res, 400, { error: "잘못된 이름" });
      const raw = String(req.headers["x-filename"] || "video.mp4");
      const ext = extname(decodeURIComponent(raw)).toLowerCase();
      if (!VIDEO_EXT.has(ext)) return send(res, 400, { error: "mp4 · webm · mov 만 넣을 수 있습니다" });
      const dir = join(ASSETS, slug); mkdirSync(dir, { recursive: true });
      const fname = `vid-${Date.now()}${ext}`;
      const dest = join(dir, fname);
      try {
        await new Promise((ok, no) => {
          let size = 0; let killed = false;
          const out = createWriteStream(dest);
          req.on("data", (c) => {
            size += c.length;
            if (size > VIDEO_LIMIT && !killed) { killed = true; out.destroy(); req.destroy(); no(new Error("too-large")); }
          });
          req.on("error", no);
          out.on("error", no);
          out.on("finish", () => ok());
          req.pipe(out);
        });
      } catch (e) {
        try { rmSync(dest, { force: true }); } catch {}
        if (e.message === "too-large") return send(res, 413, { error: "300MB 이하 영상만 넣을 수 있습니다" });
        throw e;
      }
      const mb = statSync(dest).size / (1024 * 1024);
      return send(res, 200, {
        url: `../assets/${slug}/${fname}`, name: fname, sizeMB: Math.round(mb * 10) / 10,
        warn: mb > 200 ? "200MB 가 넘습니다 — 덱이 무거워질 수 있습니다" : null,
      });
    }

    // 영상에서 떠낸 첫 화면(포스터). 이미지 경로를 그대로 쓰되 이름만 구분한다.
    const mPoster = path.match(/^\/api\/posters\/([^/]+)$/);
    if (mPoster && req.method === "POST") {
      const slug = mPoster[1];
      if (!okSlug(slug)) return send(res, 400, { error: "잘못된 이름" });
      const { dataUrl } = JSON.parse(await readBody(req));
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl || "");
      if (!m) return send(res, 400, { error: "이미지 dataUrl 필요" });
      const dir = join(ASSETS, slug); mkdirSync(dir, { recursive: true });
      const fname = `poster-${Date.now()}.${m[1] === "jpeg" ? "jpg" : "png"}`;
      writeFileSync(join(dir, fname), Buffer.from(m[2], "base64"));
      return send(res, 200, { url: `../assets/${slug}/${fname}` });
    }

    if (path === "/api/templates" && req.method === "GET")
      return send(res, 200, listTemplates(ROOT));

    if (path === "/api/generate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const job = startGenerateJob(ROOT, body);
      return send(res, 200, { jobId: job.id });
    }
    const mJob = path.match(/^\/api\/jobs\/([\w-]+)$/);
    if (mJob && req.method === "GET") {
      const j = getJob(mJob[1]) || getDeckEditJob(mJob[1]);
      return j ? send(res, 200, j.publicState()) : send(res, 404, { error: "없는 잡" });
    }

    if (path === "/api/ai-edit" && req.method === "POST") {
      const { slideHtml, instruction, slug } = JSON.parse(await readBody(req));
      if (!slideHtml || !instruction) return send(res, 400, { ok: false, error: "slideHtml·instruction 필요" });
      const out = await aiEditSlide(ROOT, slug, slideHtml, instruction);
      return send(res, out.ok ? 200 : 502, out);
    }

    // 덱 단위 AI 수정 — 자료를 읽고, 장을 늘리거나 지울 수 있다. 잡으로 돌고 /api/jobs/:id 로 폴링.
    if (path === "/api/ai-deck-edit" && req.method === "POST") {
      const { slug, instruction, index } = JSON.parse(await readBody(req));
      if (!slug || !instruction) return send(res, 400, { error: "slug·instruction 필요" });
      try {
        const job = startDeckEditJob(ROOT, { slug, instruction, index });
        return send(res, 200, { jobId: job.id });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // 편집기가 "조사 폴더가 몇 곳 열려 있는지" 를 안내에 쓴다.
    if (path === "/api/ai-research" && req.method === "GET") {
      const engine = currentEngine();
      const { dirs } = loadResearchConfig(ROOT);
      return send(res, 200, { dirs: engine?.id === "claude" ? dirs : [] });
    }

    // 지금 연결된 AI — 만들기 창이 안내에 쓴다.
    if (path === "/api/engine" && req.method === "GET") {
      const engine = currentEngine();
      return send(res, 200, engine ? { id: engine.id, label: engine.label } : { id: null, label: null });
    }

    // ───────── 정적 파일
    // 가이드의 그림 경로가 상대경로라 끝에 / 가 있어야 한다.
    if (path === "/guide") { res.writeHead(302, { Location: "/guide/" }); return res.end(); }
    let file = null;
    if (path === "/" || path === "/index.html") file = join(APP, "index.html");
    else if (path === "/editor") file = join(APP, "editor.html");
    else if (path === "/guide/") file = join(GUIDE, "index.html");
    else if (path.startsWith("/guide/")) file = safeJoin(GUIDE, path.slice(7));
    else if (path.startsWith("/app/")) file = safeJoin(APP, path.slice(5));
    else if (path.startsWith("/decks/")) file = safeJoin(DECKS, path.slice(7));
    else if (path.startsWith("/assets/")) file = safeJoin(ASSETS, path.slice(8));

    if (file && existsSync(file)) {
      const ext = extname(file).toLowerCase();
      // 덱을 열 때마다 영상 장치가 최신인지 확인한다 (보관본·휴지통은 건드리지 않는다)
      if (ext === ".html" && path.startsWith("/decks/") && !path.includes("/.")) syncVideoRuntime(file);
      if (VIDEO_EXT.has(ext)) return sendVideo(req, res, file, MIME[ext]);
      return send(res, 200, readFileSync(file), MIME[ext] || "application/octet-stream");
    }
    return send(res, 404, "없습니다: " + path, "text/plain; charset=utf-8");
  } catch (err) {
    if (err.message === "too-large") return send(res, 413, { error: "너무 큽니다" });
    console.error(`[ERR] ${req.method} ${path}:`, err.message);
    return send(res, 500, { error: err.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`❌ 포트 ${PORT} 사용 중 → node server.mjs --port 4901`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("🪄  한이룸의 슬라이드 마법사");
  console.log(`   http://localhost:${PORT}/`);
  console.log("   (종료 = Ctrl+C)");
});
