# pretty-korean-pull-request

현재 브랜치의 변경 사항을 읽고, **짧고 자연스러운 한국어 PR**을 작성하는 Claude Code 스킬입니다. 초안을 보여 주고 승인을 받은 뒤에만 `gh pr create`를 실행합니다.

## 설치

Claude Code에서 아래 두 명령을 실행합니다.

```
/plugin marketplace add coder013/pretty-korean-pull-request
/plugin install pretty-korean-pull-request@pretty-korean-pull-request
```

설치한 뒤에는 Claude Code를 다시 시작합니다.

## 사용

PR을 올릴 브랜치에서 아래처럼 요청합니다.

```
/pretty-korean-pull-request
```

"PR 만들어줘", "PR 올려줘"처럼 말해도 스킬이 동작합니다.

### 필요한 것

- [GitHub CLI](https://cli.github.com/)(`gh`)를 설치하고 `gh auth login`으로 인증해야 합니다.
- 원격 저장소가 GitHub에 있어야 합니다.

## 작성 형식

- **제목:** `type(TICKET-123): 설명`이고, 티켓이 없으면 `type: 설명`입니다. 티켓 번호는 브랜치 이름에서 먼저 찾고, 없으면 커밋 메시지에서 찾습니다.
- **본문:** 💡 Summary, 🛠️ Changes(API 표와 변경 내용), ⚠️ Impact, 🔍 Testing 순서로 씁니다. 저장소에 PR 템플릿이 있으면 그 구조를 따릅니다.
- **문체:** 불릿은 합니다체로 끝내고, 조사와 어미를 빼서 줄이지 않습니다. 대신 담을 항목 수를 줄입니다.
- **확인:** 테스트 근거나 변경 이유를 찾지 못하면 초안 아래에 질문을 붙여서 묻습니다. push와 PR 생성은 각각 승인을 받은 뒤에 실행합니다.

## 업데이트

```
/plugin marketplace update pretty-korean-pull-request
```

## 출처와 라이선스

MIT 라이선스입니다. 자연스러운 한국어 문장을 쓰기 위한 지침(`references/fluent-korean.md`)은 [snflkd/fluent-korean](https://github.com/snflkd/fluent-korean)(MIT)에서 가져와 일부 수정했습니다. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
