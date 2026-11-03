// folders.mjs — 덱 폴더(가상). 파일은 decks/ 에 평면으로 두고,
// 덱 head 의 <meta name="deck-folder" content="…"> 한 줄이 "어느 폴더인가" 를 말한다.
//
//  · 무대(<main class="deck-stage">) 밖만 건드리므로 지문(fingerprint)은 변하지 않는다.
//  · 폴더 순서·빈 폴더는 config/folders.json 에 남긴다 (덱이 하나도 없어도 폴더가 보이게).
//  · 폴더가 없는 덱 = "미분류". 폴더 이름은 파일 이름이 아니므로 공백·점 모두 허용.

import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";

const META_RE = /<meta name="deck-folder" content="([^"]*)"\s*\/?>\s*\n?/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** 폴더 이름 정리. 비어 있으면 "" (= 미분류). */
export function cleanFolderName(name) {
  return String(name ?? "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function extractFolder(html) {
  const m = html.match(META_RE);
  return m ? cleanFolderName(unesc(m[1])) : "";
}

/** head 안의 폴더 메타를 바꾼 HTML 을 돌려준다. folder 가 "" 면 메타를 뗀다. */
export function setFolderMeta(html, folder) {
  folder = cleanFolderName(folder);
  const line = folder ? `<meta name="deck-folder" content="${esc(folder)}">\n` : "";
  if (META_RE.test(html)) return html.replace(META_RE, line);
  if (!folder) return html;
  // <title> 바로 뒤가 가장 자연스럽다. 없으면 <head> 뒤.
  if (/<\/title>\s*\n?/.test(html)) return html.replace(/<\/title>\s*\n?/, (m) => m.trimEnd() + "\n" + line);
  if (/<head[^>]*>\s*\n?/.test(html)) return html.replace(/<head[^>]*>\s*\n?/, (m) => m.trimEnd() + "\n" + line);
  return line + html;
}

/** 덱 파일의 폴더를 바꾼다. mtime 은 보존한다 (폴더 이동이 "최근 수정" 순서를 흔들지 않게). */
export function setDeckFolder(file, folder) {
  const html = readFileSync(file, "utf8");
  const next = setFolderMeta(html, folder);
  if (next === html) return false;
  const st = statSync(file);
  writeFileSync(file, next, "utf8");
  try { utimesSync(file, st.atime, st.mtime); } catch {}
  return true;
}

// ── config/folders.json
function cfgPath(root) { return join(root, "config", "folders.json"); }

export function loadFolderConfig(root) {
  try {
    const j = JSON.parse(readFileSync(cfgPath(root), "utf8"));
    return Array.isArray(j.folders) ? j.folders.map(cleanFolderName).filter(Boolean) : [];
  } catch { return []; }
}
export function saveFolderConfig(root, folders) {
  mkdirSync(join(root, "config"), { recursive: true });
  const uniq = [...new Set(folders.map(cleanFolderName).filter(Boolean))];
  writeFileSync(cfgPath(root), JSON.stringify({ folders: uniq }, null, 2) + "\n", "utf8");
  return uniq;
}

/**
 * 폴더 목록 = config 순서 + (config 에 없지만 덱이 쓰는 폴더). 각 폴더의 덱 수를 함께.
 * decks: listDecks() 결과 (folder 필드 포함)
 */
export function listFolders(root, decks) {
  const cfg = loadFolderConfig(root);
  const counts = new Map();
  let unfiled = 0;
  for (const d of decks) { if (d.folder) counts.set(d.folder, (counts.get(d.folder) || 0) + 1); else unfiled++; }
  const names = [...cfg, ...[...counts.keys()].filter((n) => !cfg.includes(n))];
  return {
    folders: names.map((name) => ({ name, count: counts.get(name) || 0 })),
    unfiled, total: decks.length,
  };
}

export function createFolder(root, name) {
  name = cleanFolderName(name);
  if (!name) throw new Error("폴더 이름을 적어 주세요");
  const cfg = loadFolderConfig(root);
  if (cfg.includes(name)) return { ok: true, name, existed: true };
  saveFolderConfig(root, [...cfg, name]);
  return { ok: true, name };
}

/** 폴더 이름 변경 — config 와 그 폴더의 덱 메타를 모두 바꾼다. */
export function renameFolder(root, deckFiles, from, to) {
  from = cleanFolderName(from); to = cleanFolderName(to);
  if (!from || !to) throw new Error("폴더 이름을 적어 주세요");
  if (from === to) return { ok: true, moved: 0 };
  const cfg = loadFolderConfig(root);
  if (cfg.includes(to)) throw new Error("같은 이름의 폴더가 이미 있습니다");
  saveFolderConfig(root, cfg.map((n) => (n === from ? to : n)).concat(cfg.includes(from) ? [] : [to]));
  let moved = 0;
  for (const f of deckFiles) {
    if (extractFolder(readFileSync(f, "utf8")) === from) { setDeckFolder(f, to); moved++; }
  }
  return { ok: true, moved };
}

/** 폴더 삭제 — 덱은 지우지 않고 미분류로 보낸다. */
export function deleteFolder(root, deckFiles, name) {
  name = cleanFolderName(name);
  const cfg = loadFolderConfig(root);
  saveFolderConfig(root, cfg.filter((n) => n !== name));
  let moved = 0;
  for (const f of deckFiles) {
    if (extractFolder(readFileSync(f, "utf8")) === name) { setDeckFolder(f, ""); moved++; }
  }
  return { ok: true, moved };
}
