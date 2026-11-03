#!/usr/bin/env node
// research-guard.mjs — 「AI 수정 · 자료 조사」의 문지기. PreToolUse 훅으로 붙는다.
//
// 왜 권한 glob 이 아니라 훅인가:
//   permissions.allow/deny 의 glob 매칭 규칙이 우리 의도와 달랐다. 실측 결과
//     · `**/x` 는 작업 폴더 기준이라 --add-dir 폴더에는 걸리지 않았고,
//     · --add-dir 를 주면 그 폴더의 *상위* 까지 열렸고,
//     · 상위를 deny 로 막으면 허용 폴더까지 같이 죽었다.
//   그래서 매칭을 추측하지 않고 여기서 직접 판정한다. 경로를 resolve 해서
//   허용 폴더 안인지 문자열이 아니라 경로로 확인한다.
//
// 판정: 허용 폴더 안 + 금지 이름이 아님 → 통과. 그 외 전부 거부.
// 설정은 ALLOW_ROOTS / DENY_FILE_PATTERNS 환경변수(JSON)로 받는다.

import { resolve, relative, isAbsolute, basename, sep } from "node:path";

const readStdin = async () => {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
};

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

const allow = () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "조사 허용 폴더",
    },
  }));
  process.exit(0);
};

/** glob 이름 규칙(.env, *token*, *.csv …)을 정규식으로. 경로가 아니라 '파일 이름'만 본다. */
const nameMatcher = (pattern) =>
  new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");

function main(input) {
  let ev;
  try { ev = JSON.parse(input); } catch { deny("훅 입력을 읽지 못했습니다"); }

  const tool = ev.tool_name || "";
  const ti = ev.tool_input || {};

  // 파일을 건드리지 않는 도구는 애초에 주지 않았다. 혹시 오면 막는다.
  if (!["Read", "Grep", "Glob"].includes(tool)) deny(`${tool} 은(는) 조사에 허용되지 않은 도구입니다`);

  const roots = JSON.parse(process.env.GUARD_ALLOW_ROOTS || "[]").map((r) => resolve(r));
  const denyNames = JSON.parse(process.env.GUARD_DENY_NAMES || "[]").map(nameMatcher);
  const denyDirs = JSON.parse(process.env.GUARD_DENY_DIRS || "[]");

  // 도구마다 경로가 실린 자리가 다르다. 하나라도 허용 폴더 밖이면 거부.
  const targets = [ti.file_path, ti.path, ti.notebook_path].filter(Boolean);
  // Glob 의 pattern 이 절대경로로 올 때만 검사 대상(상대 패턴은 path 로 판정된다)
  if (typeof ti.pattern === "string" && isAbsolute(ti.pattern)) targets.push(ti.pattern);
  if (!targets.length) deny("경로가 없는 호출은 허용하지 않습니다");

  for (const t of targets) {
    const p = resolve(t);

    const inside = roots.some((r) => {
      const rel = relative(r, p);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) deny(`조사 허용 폴더 밖입니다: ${p}`);

    const parts = p.split(sep);
    for (const d of denyDirs) {
      const seg = d.split("/").filter(Boolean);
      for (let i = 0; i + seg.length <= parts.length; i++) {
        if (seg.every((x, k) => parts[i + k] === x)) deny(`열람이 막힌 폴더입니다: ${d}`);
      }
    }

    const name = basename(p);
    if (denyNames.some((re) => re.test(name))) deny(`열람이 막힌 파일입니다: ${name}`);
  }

  allow();
}

main(await readStdin());
