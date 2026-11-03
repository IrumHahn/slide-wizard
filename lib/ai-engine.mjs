// ai-engine.mjs — 「AI로 만들기」·「AI 수정」이 부르는 AI 를 한 곳에서 정한다.
//
// 기본은 Codex. 없으면 Claude Code. API 키는 쓰지 않고, 이미 로그인한 CLI 를 그대로 빌린다.
// 강제로 고르려면: SLIDE_AI_ENGINE=codex|claude · 모델을 정하려면: SLIDE_AI_MODEL=...
//
// 버튼으로 부르는 Codex 에겐 도구를 주지 않는다(셸·MCP·웹 전부 끔). 글만 받아 글만 돌려준다.
// Codex 의 read-only 샌드박스는 "쓰기"만 막고 읽기는 디스크 전체라서, 셸을 켜 두면
// 붙여넣은 재료 속 문장 하나로 다른 폴더의 비밀 파일을 읽힐 수 있다.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const IS_WIN = process.platform === "win32";
const HOME = homedir();

/** 더블클릭으로 뜬 서버는 PATH 가 짧아서 nvm·앱 안의 CLI 를 못 찾는다. 직접 찾아 본다. */
function findBin(name, envKey, extra = []) {
  if (process.env[envKey]) return process.env[envKey];
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    dirname(process.execPath),
    "/opt/homebrew/bin", "/usr/local/bin",
    join(HOME, ".local", "bin"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : []),
    ...extra,
  ];
  const nvm = join(HOME, ".nvm", "versions", "node");
  if (existsSync(nvm)) for (const v of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, v, "bin"));
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  }
  return null;
}

const bins = () => ({
  codex: findBin("codex", "CODEX_BIN", [
    "/Applications/Codex.app/Contents/Resources",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin",
  ]),
  claude: findBin("claude", "CLAUDE_BIN", [join(HOME, ".claude", "local")]),
});

/** 지금 쓸 AI. { id, label, bin } 또는 찾지 못하면 null */
export function currentEngine() {
  const b = bins();
  const want = process.env.SLIDE_AI_ENGINE;
  const order = want === "claude" ? ["claude", "codex"] : ["codex", "claude"];
  for (const id of order) {
    if (b[id]) return { id, label: id === "codex" ? "Codex" : "Claude Code", bin: b[id] };
  }
  return null;
}

export const NO_ENGINE = "Codex를 찾지 못했어요. 가이드의 「준비물」을 따라 Codex를 설치하고 로그인해 주세요.";

/** Windows 의 .cmd 는 셸로만 실행된다. 프롬프트는 stdin 으로 가므로 인자에 사용자 글이 섞이지 않는다. */
function launch(bin, args, opts) {
  if (!IS_WIN) return spawn(bin, args, opts);
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  return spawn([bin, ...args].map(q).join(" "), { ...opts, shell: true });
}

function friendly(raw, label) {
  const text = String(raw || "");
  if (/log.?in|not authenticated|unauthorized|401/i.test(text)) return `${label} 로그인이 필요해요. 터미널에서 로그인한 뒤 다시 눌러 주세요.`;
  if (/usage limit|rate limit|quota|429/i.test(text)) return `${label} 사용량이 다 찼어요. 조금 뒤에 다시 해 주세요.`;
  return text.trim().slice(-300) || `${label} 실행에 실패했어요.`;
}

function exec(engine, args, prompt, { cwd, env, timeoutMs }, onDone) {
  return new Promise((resolve) => {
    const child = launch(engine.bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.on("error", () => {});      // 실행 실패 시 EPIPE 로 서버가 죽지 않게
    child.stdin.end(prompt);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, error: `${engine.label} 응답이 너무 오래 걸려서 멈췄어요. 장수를 줄여 다시 해 보세요.` });
      if (code !== 0) return resolve({ ok: false, error: friendly(err || out, engine.label) });
      resolve(onDone(out));
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: friendly(e.message, engine.label) }); });
  });
}

function runCodex(engine, prompt, { effort, timeoutMs }) {
  const work = mkdtempSync(join(tmpdir(), "slide-wizard-"));
  const answer = join(work, "answer.txt");
  const args = [
    "exec", "--skip-git-repo-check", "--ephemeral",
    "--sandbox", "read-only",
    "--disable", "shell_tool",
    "-c", "mcp_servers={}",
    "-c", 'web_search="disabled"',
    "-c", `model_reasoning_effort="${effort}"`,
    ...(process.env.SLIDE_AI_MODEL ? ["-m", process.env.SLIDE_AI_MODEL] : []),
    "-C", work,
    "--output-last-message", answer,
    "-",
  ];
  return exec(engine, args, prompt, { cwd: work, timeoutMs }, () => {
    try { return { ok: true, text: readFileSync(answer, "utf8") }; }
    catch { return { ok: false, error: "Codex 답을 읽지 못했어요." }; }
  }).finally(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* 지워지지 않아도 무해 */ } });
}

function runClaudeCli(engine, prompt, { tier, effort, timeoutMs, cwd, tools, settings, addDirs = [], env }) {
  const model = process.env.SLIDE_AI_MODEL || (tier === "smart" ? "opus" : "sonnet");
  const args = ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--tools", ...(tools?.length ? tools : [""])];
  if (settings) args.push("--settings", JSON.stringify(settings));
  for (const d of addDirs) args.push("--add-dir", d);
  return exec(engine, args, prompt, { cwd, env, timeoutMs }, (out) => {
    try {
      const text = JSON.parse(out).result ?? "";
      return { ok: true, text: typeof text === "string" ? text : JSON.stringify(text) };
    } catch { return { ok: false, error: "Claude 답을 읽지 못했어요." }; }
  });
}

/**
 * 프롬프트를 보내고 글을 받는다. { ok, text } 또는 { ok:false, error }.
 * tier: fast(개요·슬라이드 생성) | smart(수정). effort: low|medium|high.
 * tools·settings·addDirs·cwd·env 는 Claude Code 의 「자료 조사」에서만 쓴다.
 */
export function runAI(prompt, { tier = "fast", effort = "medium", timeoutMs = 240_000, ...rest } = {}) {
  const engine = currentEngine();
  if (!engine) return Promise.resolve({ ok: false, error: NO_ENGINE });
  return engine.id === "codex"
    ? runCodex(engine, prompt, { effort, timeoutMs })
    : runClaudeCli(engine, prompt, { tier, effort, timeoutMs, ...rest });
}
