# 🪄 한이룸의 슬라이드 마법사

**말하면 슬라이드가 뚝딱.** Codex에게 하고 싶은 말만 적으면 멋진 발표자료를 만들어 주는 프로그램이에요.

## 📖 [아주 쉬운 가이드 보기](https://irumhahn.github.io/slide-wizard/)

처음이라면 가이드만 따라 하면 돼요.

## 빠른 시작

1. [내려받아](https://github.com/IrumHahn/slide-wizard/archive/refs/heads/main.zip) 압축을 풀어요.
2. ChatGPT 앱에서 **Codex**를 고르고 그 폴더를 열어요.
3. 이렇게 말해요.

```
슬라이드 마법사 켜줘
```

```
슬라이드 만들어줘. 우리 반 친구들에게 재활용 하는 법을 알려 주는 발표야. 밝게 10장.
```

## 할 수 있는 것

- Codex에게 말로 슬라이드 만들기, 고치기, 검사하기
- 「AI로 만들기」 버튼으로 빠르게 만들기
- 글자 클릭해서 바로 고치기, 사진·영상 넣기, 순서 바꾸기
- 디자인 4종, 테마 바꾸기, 발표, PDF 저장

슬라이드는 내 컴퓨터의 `decks/` 폴더에만 저장돼요. AI에게 부탁한 글과 자료는 AI 처리를 위해 해당 서비스로 전달돼요.

## 개발자용

- 필요한 것: Node.js 18 이상. 설치할 패키지는 없어요.
- 실행: `node server.mjs` → http://localhost:4900
- AI 에이전트 작업 규칙: [AGENTS.md](AGENTS.md)
- 명령어: `node scripts/wizard.mjs help`

| 환경 변수 | 뜻 | 기본값 |
|---|---|---|
| `SLIDE_AI_ENGINE` | `codex` 또는 `claude` | Codex, 없으면 Claude Code |
| `SLIDE_AI_MODEL` | 사용할 모델 | 각 CLI 설정 (Claude는 Sonnet·Opus) |
| `CODEX_BIN`, `CLAUDE_BIN` | CLI 경로 | 자동으로 찾음 |
| `CHROME_BIN` | 검사에 쓸 브라우저 경로 | 자동으로 찾음 |
| `PRESENT_PORT` | 포트 | 4900 |

## 라이선스

[MIT](LICENSE). 포함된 글꼴 [Pretendard](https://github.com/orioncactus/pretendard)는 수정하지 않은 공식 파일이며 SIL Open Font License 1.1을 따릅니다([전문](decks/lecture-assets/fonts/OFL.txt)).
