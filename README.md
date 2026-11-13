# pretty-korean-pull-request

**짧고 자연스러운 한국어로 PR을 쓰고 리뷰하는** Claude Code 플러그인입니다. 두 스킬이 들어 있습니다.

| 스킬 | 하는 일 |
|---|---|
| `/pretty-korean-pull-request:create` | 현재 브랜치의 변경 사항으로 PR 제목과 본문을 쓰고, 승인을 받은 뒤 PR을 만듭니다. |
| `/pretty-korean-pull-request:review` | 열린 PR을 골라 리뷰하고, 패널에서 피드백을 고르고 고친 뒤 GitHub 리뷰로 게시합니다. |

## 설치

Claude Code에서 아래 두 명령을 실행합니다.

```
/plugin marketplace add coder013/pretty-korean-pull-request
/plugin install pretty-korean-pull-request@pretty-korean-pull-request
```

설치한 뒤에는 Claude Code를 다시 시작합니다.

### 필요한 것

- [GitHub CLI](https://cli.github.com/)(`gh`)를 설치하고 `gh auth login`으로 인증해야 합니다.
- 원격 저장소가 GitHub에 있어야 합니다.
- `review`의 패널은 Claude Code의 mod 기능으로 그립니다. 최신 Claude Code가 필요합니다.

## create: PR 작성

PR을 올릴 브랜치에서 아래처럼 요청합니다. "PR 만들어줘", "PR 올려줘"처럼 말해도 됩니다.

```
/pretty-korean-pull-request:create
```

- **제목:** `type(TICKET-123): 설명`이고, 티켓이 없으면 `type: 설명`입니다. 티켓 번호는 브랜치 이름에서 먼저 찾고, 없으면 커밋 메시지에서 찾습니다.
- **본문:** 💡 Summary, 🛠️ Changes(API 표와 변경 내용), ⚠️ Impact, 🔍 Testing 순서로 씁니다. 저장소에 PR 템플릿이 있으면 그 구조를 따릅니다.
- **문체:** 불릿은 합니다체로 끝내고, 조사와 어미를 빼서 줄이지 않습니다. 대신 담을 항목 수를 줄입니다.
- **확인:** 테스트 근거나 변경 이유를 찾지 못하면 초안 아래에 질문을 붙여서 묻습니다. push와 PR 생성은 각각 승인을 받은 뒤에 실행합니다.

## review: PR 리뷰

리뷰할 저장소에서 아래처럼 요청합니다. "PR 리뷰해줘"처럼 말해도 됩니다.

```
/pretty-korean-pull-request:review
```

대화창 옆에 리뷰 패널이 열리고, 아래 순서로 진행됩니다.

1. **PR 선택:** 열린 PR이 모두 보입니다. 나에게 리뷰가 요청된 PR에는 표시가 붙습니다.
2. **리뷰:** Claude가 변경 전체를 읽고 피드백을 씁니다. 피드백은 이번 변경에 대한 것만 다루고, diff 안의 줄에 답니다.
3. **확인과 수정:** 패널에서 피드백을 고르고, 본문과 제안 코드를 그 자리에서 고칩니다. 총평과 리뷰 결과(코멘트, 변경 요청, 승인)도 바꿀 수 있습니다.
4. **게시:** 게시 버튼을 누르면 고른 피드백만 리뷰 하나로 묶어서 올립니다. 누르기 전에는 아무것도 게시하지 않습니다.

- **심각도:** `버그`, `제안`, `질문`, `사소` 네 가지입니다. 게시할 때 본문 앞에 `**[제안]**`처럼 붙습니다. `사소`는 처음에 선택 해제되어 있습니다.
- **제안 코드:** 고칠 범위가 짧고 분명할 때만 붙고, GitHub에서 바로 적용할 수 있는 suggestion으로 게시됩니다.
- **리뷰 결과:** 버그가 있으면 변경 요청, 없으면 코멘트를 추천해서 미리 골라 둡니다. 내 PR이면 코멘트로만 게시합니다.

## 업데이트

```
/plugin marketplace update pretty-korean-pull-request
/plugin update pretty-korean-pull-request@pretty-korean-pull-request
```

## 출처와 라이선스

MIT 라이선스입니다. 자연스러운 한국어 문장을 쓰기 위한 지침(`references/fluent-korean.md`)은 [snflkd/fluent-korean](https://github.com/snflkd/fluent-korean)(MIT)에서 가져와 일부 수정했습니다. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
