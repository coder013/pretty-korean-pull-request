---
name: review
description: 저장소의 열린 PR을 골라 자연스러운 한국어로 리뷰하고, 사용자가 로컬 브라우저 리뷰 페이지에서 피드백을 고르고 고친 뒤 GitHub 리뷰로 게시한다. "PR 리뷰", "리뷰해줘", "코드 리뷰", "/pretty-korean-pull-request:review" 요청 시 사용한다.
---

열린 PR을 골라 한국어로 리뷰하고, 사용자가 리뷰 페이지에서 확인한 피드백만 게시한다.

리뷰 페이지는 이 스킬이 띄우는 로컬 서버가 브라우저 탭으로 보여 준다. 역할을 나눈다. **페이지는 보여 주고 입력을 받기만 하고, GitHub 조회와 리뷰와 게시는 이 스킬이 한다.** 서버와는 `scripts/review_server.py`의 하위 명령으로 주고받는다. 아래에서 `SERVER`는 `python3 <이 스킬 폴더>/scripts/review_server.py`를 뜻한다. 이 스킬 폴더는 스킬을 불러올 때 표시되는 Base directory다.

| 명령 | 하는 일 |
|---|---|
| `SERVER start --repo <저장소> --viewer <login>` | 표준 입력으로 받은 PR 목록으로 서버를 띄우고 브라우저를 연다 |
| `SERVER wait --dir <dir>` | 페이지에서 사용자가 한 다음 동작을 JSON 한 줄로 출력하고 끝난다 |
| `SERVER ranges --diff <파일>` | 파일별로 코멘트를 달 수 있는 줄 범위를 출력한다 |
| `SERVER feedback --dir <dir> --review <파일> --diff <파일>` | 피드백 편집 화면을 보여 준다 |
| `SERVER done --dir <dir> --url <url>` | 게시 결과를 보여 주고 서버를 끝낸다 |
| `SERVER error --dir <dir> --message <문장>` | 오류를 보여 주고 서버를 끝낸다 |
| `SERVER stop --dir <dir>` | 서버를 끝낸다 |

모든 명령은 JSON 한 줄을 출력한다. `ok`가 `false`이면 `error`에 이유가 있다.

**사용자의 동작은 `wait`로 기다린다.** `wait`는 Bash 도구의 `run_in_background: true`로 실행하고, 텍스트 없이 턴을 끝낸다. 사용자가 페이지에서 동작하면 `wait`가 끝나고 완료 알림이 온다. 알림을 받으면 `wait`의 출력을 읽고 아래 절차대로 이어서 처리한다. **`wait`를 포그라운드로 실행하거나, 끝나기를 기다리며 다른 명령으로 확인하지 않는다.**

**대화창에는 아무것도 쓰지 않는다.** 사용자는 페이지에서 모든 것을 확인한다. 진행 상황("diff를 모두 읽었습니다"), 찾은 피드백 요약, 다음 할 일 안내를 쓰지 않고, 명령만 실행하고 텍스트 없이 턴을 끝낸다. 대화창에 쓰는 것은 아래 경우뿐이다.
- 열린 PR이 없을 때
- 브라우저를 열지 못했을 때(페이지 주소 안내)
- `python3`가 없거나, 명령이나 게시가 실패했을 때

## 1. 페이지 열기

1. 저장소와 현재 사용자를 확인한다.
   ```bash
   gh repo view --json nameWithOwner --jq .nameWithOwner
   gh api user --jq .login
   ```
2. 열린 PR 목록을 서버에 넘겨 페이지를 연다.
   ```bash
   gh pr list --state open --limit 500 --json number,title,author,additions,deletions,reviewRequests \
     | SERVER start --repo <저장소> --viewer <login>
   ```
3. 출력에 따라 처리한다.
   - `empty: true`: 리뷰할 열린 PR이 없다고 알리고 종료한다.
   - `ok: true`: 출력의 `dir`을 이후 모든 명령에 쓴다. `opened`가 `false`이면 브라우저를 열지 못한 것이므로, `url`을 대화창에 알리고 직접 열어 달라고 한 줄로 안내한다.
   - 그 밖의 실패: 오류를 그대로 알리고 종료한다. `python3`가 없으면 설치가 필요하다고 안내한다.
4. `SERVER wait --dir <dir>`를 백그라운드로 실행하고, 텍스트 없이 턴을 끝낸다.

## 2. `wait` 결과 처리

| 출력 | 처리 |
|---|---|
| `{"type":"select","number":N}` | 3~4단계(리뷰, 피드백 쓰기)를 진행한다 |
| `{"type":"publish",...}` | 5단계(게시)를 진행한다 |
| `{"type":"cancel"}`, `{"type":"close"}`, `{"type":"closed"}` | 아무것도 게시하지 않고, 텍스트 없이 턴을 끝낸다 |

`closed`는 사용자가 페이지를 30분 넘게 버려 두었거나 서버가 끝난 경우다. 다시 `wait`를 실행하지 않는다.

흐름이 멈췄을 때(사용자가 "리뷰 계속", "리뷰 페이지가 그대로야"라고 말할 때)는 같은 `dir`로 `wait`를 다시 백그라운드로 실행한다. 이미 받지 못한 동작이 있으면 바로 출력된다. 서버가 끝났으면 `closed`가 나오므로, 그때는 스킬을 처음부터 다시 실행하라고 안내한다.

## 3. 리뷰

페이지는 PR을 고른 순간 리뷰 중 화면으로 바뀐다. 따로 알릴 필요는 없다.

1. PR 정보와 diff를 받는다. diff는 세션 폴더에 저장하고 Read로 읽는다. 길면 나눠서 읽는다.
   ```bash
   gh pr view <번호> --json title,author,headRefOid,files,body
   gh pr diff <번호> > <dir>/pr.diff
   ```
2. diff 밖의 코드를 봐야 하면 PR head를 받아서 읽는다. **작업 트리와 현재 브랜치는 바꾸지 않는다.** `git checkout`, `git switch`, `gh pr checkout`은 쓰지 않는다.
   ```bash
   git fetch origin pull/<번호>/head
   git show <headRefOid>:<경로>
   ```
3. **diff의 모든 파일을 끝까지 읽는다.** PR이 크다는 이유로 파일을 건너뛰지 않는다. 읽으면서 찾은 문제는 바로 기록해 둔다.
4. 같은 PR에 이미 달린 리뷰 코멘트는 확인하지 않아도 된다. 겹치는 지적이 있어도 그대로 쓴다.

## 4. 피드백 쓰기

먼저 [../create/references/fluent-korean.md](../create/references/fluent-korean.md)를 읽고, 그 지침을 피드백 본문과 총평에 적용한다. 지침은 요약하지 말고 예시까지 그대로 참고한다.

### 범위

- **이번 변경(diff)에 대한 피드백만 쓴다.** 바꾸지 않은 코드의 오래된 문제는 지적하지 않는다.
- 바꾼 코드 때문에 diff 밖의 코드가 깨지면(시그니처를 바꿨는데 호출부를 안 고친 경우 등), 그 원인이 된 diff 줄에 피드백을 단다.
- 코멘트는 diff에 포함된 줄에만 달 수 있다. `SERVER ranges --diff <dir>/pr.diff`로 파일별 코멘트 가능 범위를 구하고, 범위 밖을 가리키는 지적은 피드백에서 빼서 총평에 넣는다. 여러 줄 피드백은 시작 줄과 끝 줄이 같은 범위 안에 있어야 한다.

### 심각도

| 심각도 | 기준 |
|---|---|
| `버그` | 잘못 동작하거나, 예외나 장애나 데이터 오류가 날 수 있다 |
| `제안` | 동작은 맞지만 더 나은 방법이 있다(가독성, 성능, 구조) |
| `질문` | 의도를 확인해야 판단할 수 있다 |
| `사소` | 이름, 포맷, 오타, 주석 |

### 본문

- 무엇이 문제인지, 왜 문제인지, 어떻게 바꾸면 되는지를 순서대로 쓴다. 2~4문장이면 충분하다.
- 합니다체로 쓰되, 제안과 질문은 "~하면 어떨까요?", "~한 의도인가요?"처럼 상대에게 판단을 맡기는 형태로 쓴다. "~해야 합니다"는 `버그`에만 쓴다.
- 조사와 어미를 빼서 줄이지 않는다.
- 코드 식별자, 파일 경로, 값은 백틱으로 감싸고, 영어 식별자 뒤의 조사는 붙여 쓴다.
- 본문에 `[버그]` 같은 라벨을 쓰지 않는다. 라벨은 게시할 때 붙인다.

```
X  빈 목록 예외 가능. firstOrNull 권장.
X  [버그] 회원 목록이 비어 있으면 예외가 발생함
O  회원 목록이 비어 있으면 `first()`가 `NoSuchElementException`을 던집니다. 탈퇴 대상 회원이 없는 날에는 배치 전체가 실패하게 됩니다. `firstOrNull()`로 받고 비어 있으면 바로 끝내는 건 어떨까요?
```

### 제안 코드

- 고칠 범위가 몇 줄이고 대체 코드가 분명할 때만 `suggestion`을 넣는다.
- `suggestion`은 피드백이 가리키는 줄(`startLine`~`line`) 전체를 **그대로 대체**하는 코드여야 한다. 원래 들여쓰기를 지키고, 범위 밖의 줄을 넣지 않는다.
- 확신이 없으면 넣지 않는다.

### 총평과 추천 결과

- 총평은 한두 문장으로 쓴다. PR 전체에 대한 인상과, 줄에 달지 못한 지적을 담는다. 쓸 내용이 없으면 빈 문자열로 둔다.
- `isOwnPr`: PR 작성자의 `login`이 현재 사용자와 같으면 `true`
- `recommendedEvent`
  - 내 PR이면 `COMMENT`
  - 다른 사람의 PR이고 `버그`가 하나라도 있으면 `REQUEST_CHANGES`
  - 그 밖에는 `COMMENT`. `APPROVE`는 추천하지 않는다.

### 넘기기

1. 리뷰 내용을 `<dir>/review.json`에 쓴다(Write 도구).
   ```json
   {
     "repo": "<저장소>", "number": 7, "title": "<PR 제목>", "author": "<작성자 login>",
     "headSha": "<리뷰에 쓴 headRefOid>", "isOwnPr": false,
     "summary": "<총평>", "recommendedEvent": "REQUEST_CHANGES",
     "items": [
       { "id": 1, "severity": "버그", "path": "src/A.kt", "line": 42, "body": "<본문>", "suggestion": "<대체 코드>" },
       { "id": 2, "severity": "제안", "path": "src/B.kt", "startLine": 8, "line": 10, "body": "<본문>" }
     ]
   }
   ```
   - `line`은 diff 오른쪽(바뀐 뒤) 기준 줄 번호이고, 여러 줄이면 `startLine`을 함께 쓴다.
   - `suggestion`은 없으면 뺀다.
   - `id`는 1부터 매기고, 심각도 순서(`버그`, `제안`, `질문`, `사소`)로, 같은 심각도 안에서는 파일과 줄 순서로 정렬한다.
   - 피드백이 하나도 없으면 `items`를 빈 배열로 둔다.
2. 페이지에 넘긴다.
   ```bash
   SERVER feedback --dir <dir> --review <dir>/review.json --diff <dir>/pr.diff
   ```
   - `diff 범위 밖을 가리키는 피드백이 있습니다`로 실패하면, 오류에 나온 피드백을 총평으로 옮기고 다시 실행한다.
   - `closed: true`이면 사용자가 리뷰 중에 취소했거나 서버가 끝난 것이다. 텍스트 없이 턴을 끝낸다.
3. `SERVER wait --dir <dir>`를 백그라운드로 실행하고, 텍스트 없이 턴을 끝낸다. 피드백 개수와 내용은 페이지에 나온다.

## 5. 게시

`wait`가 `{"type":"publish", "repo", "number", "payload", "comments"}`를 출력했을 때만 게시한다. 사용자가 페이지에서 게시를 누른 것이 승인이다. **다른 경로로는 게시하지 않는다.**

`payload`는 서버가 사용자의 선택과 편집 내용으로 만든 GitHub 리뷰 API 요청 본문 파일이다. 심각도 라벨(`**[버그]**`)과 `suggestion` 블록, 리뷰 결과, 총평이 이미 들어 있다. **내용을 다시 고치지 않고 그대로 게시한다.**

1. 게시한다.
   ```bash
   gh api repos/<repo>/pulls/<number>/reviews --method POST --input <payload> --jq .html_url
   ```
2. 성공하면 `SERVER done --dir <dir> --url <리뷰 URL>`을 실행하고, 텍스트 없이 턴을 끝낸다. URL은 페이지에 나온다.
3. 실패하면 아래 순서로 처리한다. 서버가 끝나면 세션 폴더가 지워지므로, `payload`를 먼저 읽는다.
   1. `payload` 파일을 Read로 읽는다.
   2. `SERVER error --dir <dir> --message "<gh 오류 메시지>"`를 실행한다.
   3. 대화창에 `gh`의 오류 메시지를 그대로 보여 주고, 게시하려던 피드백(파일:줄, 본문)을 남겨 직접 옮길 수 있게 한다. 줄 위치 오류이거나 PR에 새 커밋이 올라온 경우라면, 다시 리뷰할지 묻는다.
