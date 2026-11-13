---
name: review
description: 저장소의 열린 PR을 골라 자연스러운 한국어로 리뷰하고, 사용자가 리뷰 패널에서 피드백을 고르고 고친 뒤 GitHub 리뷰로 게시한다. "PR 리뷰", "리뷰해줘", "코드 리뷰", "/pretty-korean-pull-request:review" 요청 시, 그리고 "[리뷰 패널]"로 시작하는 메시지를 받았을 때 사용한다.
---

열린 PR을 골라 한국어로 리뷰하고, 사용자가 패널에서 확인한 피드백만 게시한다.

역할을 나눈다. **패널은 보여 주고 입력을 받기만 하고, GitHub 조회와 리뷰와 게시는 이 스킬이 한다.** 패널과는 아래 도구와 메시지로 주고받는다.

| 방향 | 수단 | 언제 |
|---|---|---|
| 스킬 → 패널 | `mcp__pretty-korean-pull-request__show_pr_list` | PR 목록을 보여 줄 때 |
| 스킬 → 패널 | `mcp__pretty-korean-pull-request__show_reviewing` | 리뷰를 시작할 때 |
| 스킬 → 패널 | `mcp__pretty-korean-pull-request__show_feedback` | 피드백 초안을 넘길 때 |
| 스킬 → 패널 | `mcp__pretty-korean-pull-request__show_done` | 게시를 마쳤을 때 |
| 패널 → 스킬 | `[리뷰 패널] PR #<번호> 선택` 메시지 | 사용자가 PR을 골랐을 때 |
| 패널 → 스킬 | `[리뷰 패널] 게시 요청` 메시지 + JSON | 사용자가 게시 버튼을 눌렀을 때 |
| 패널 → 스킬 | `[리뷰 패널] 취소` 메시지 | 사용자가 취소했을 때 |

도구는 패널 화면만 바꾸고 바로 끝난다. 사용자의 선택은 다음 메시지로 온다. 그래서 도구를 호출한 뒤에는 기다리지 말고, 패널에서 고르라고 한 줄로 알린 뒤 턴을 끝낸다.

도구가 목록에 없으면 ToolSearch로 불러온다. 그래도 없으면 패널(mod)이 로드되지 않은 것이므로, 플러그인을 최신으로 업데이트하고 Claude Code를 다시 시작하라고 안내한 뒤 종료한다.

## 1. PR 목록

1. 저장소와 현재 사용자를 확인한다.
   ```bash
   gh repo view --json nameWithOwner --jq .nameWithOwner
   gh api user --jq .login
   ```
2. 열린 PR을 모두 가져온다.
   ```bash
   gh pr list --state open --limit 500 --json number,title,author,additions,deletions,reviewRequests
   ```
3. 열린 PR이 없으면 패널을 열지 않고, 리뷰할 PR이 없다고 알린 뒤 종료한다.
4. `show_pr_list`를 호출한다. `prs`의 각 항목은 아래처럼 만든다.
   - `author`: `author.login`
   - `isReviewRequested`: `reviewRequests`에 현재 사용자의 `login`이 있으면 `true`
5. "패널에서 리뷰할 PR을 골라 주세요."라고 알리고 턴을 끝낸다.

## 2. 리뷰

`[리뷰 패널] PR #<번호> 선택` 메시지를 받으면 시작한다.

1. `show_reviewing`을 호출한다.
2. PR 정보와 diff를 받는다.
   ```bash
   gh pr view <번호> --json title,author,headRefOid,files,body
   gh pr diff <번호> > <임시 파일>
   ```
   diff는 임시 파일에 저장하고 Read로 읽는다. 길면 나눠서 읽는다.
3. diff 밖의 코드를 봐야 하면 PR head를 받아서 읽는다. **작업 트리와 현재 브랜치는 바꾸지 않는다.** `git checkout`, `git switch`, `gh pr checkout`은 쓰지 않는다.
   ```bash
   git fetch origin pull/<번호>/head
   git show <headRefOid>:<경로>
   ```
4. **diff의 모든 파일을 끝까지 읽는다.** PR이 크다는 이유로 파일을 건너뛰지 않는다. 읽으면서 찾은 문제는 바로 기록해 둔다.
5. 같은 PR에 이미 달린 리뷰 코멘트는 확인하지 않아도 된다. 겹치는 지적이 있어도 그대로 쓴다.

## 3. 피드백 쓰기

먼저 [../create/references/fluent-korean.md](../create/references/fluent-korean.md)를 읽고, 그 지침을 피드백 본문과 총평에 적용한다. 지침은 요약하지 말고 예시까지 그대로 참고한다.

### 범위

- **이번 변경(diff)에 대한 피드백만 쓴다.** 바꾸지 않은 코드의 오래된 문제는 지적하지 않는다.
- 바꾼 코드 때문에 diff 밖의 코드가 깨지면(시그니처를 바꿨는데 호출부를 안 고친 경우 등), 그 원인이 된 diff 줄에 피드백을 단다.
- 코멘트는 diff에 포함된 줄에만 달 수 있다. 아래 명령으로 파일별 코멘트 가능 범위를 구하고, 범위 밖을 가리키는 지적은 피드백에서 빼서 총평에 넣는다. 여러 줄 피드백은 시작 줄과 끝 줄이 같은 범위 안에 있어야 한다.
  ```bash
  python3 -c '
  import re, sys, json
  ranges, path = {}, None
  for line in open(sys.argv[1], encoding="utf-8"):
      if line.startswith("+++ "):
          path = None if line.strip() == "+++ /dev/null" else line[6:].rstrip("\n")
      m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
      if m and path:
          start, count = int(m.group(1)), int(m.group(2) or 1)
          if count:
              ranges.setdefault(path, []).append([start, start + count - 1])
  print(json.dumps(ranges, ensure_ascii=False))
  ' <임시 파일>
  ```

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

`show_feedback`을 호출한다. `items`의 `id`는 1부터 매기고, 심각도 순서(`버그`, `제안`, `질문`, `사소`)로, 같은 심각도 안에서는 파일과 줄 순서로 정렬한다. `headSha`에는 리뷰에 쓴 `headRefOid`를 넣는다.

피드백이 하나도 없으면 빈 `items`와 총평을 넘긴다.

호출한 뒤에는 피드백 개수를 심각도별로 한 줄에 알리고("버그 1개, 제안 2개, 사소 1개를 찾았습니다. 패널에서 확인하고 게시해 주세요."), 턴을 끝낸다.

## 4. 게시

`[리뷰 패널] 게시 요청` 메시지를 받았을 때만 게시한다. 이 메시지가 사용자의 승인이다. **다른 경로로는 게시하지 않는다.**

1. 메시지의 JSON 블록을 읽는다. 형식은 `{ repo, number, headSha, event, summary, comments: [{ severity, path, line, startLine?, body, suggestion? }] }`이다. 패널에서 사용자가 고친 내용이 들어 있으므로, **본문을 다시 고치지 않는다.**
2. `comments`가 비어 있고 `summary`도 비어 있으면 게시하지 않고, 게시할 내용이 없다고 알린다.
3. 요청 본문을 만들어 임시 파일에 저장한다.
   - `commit_id`: `headSha`
   - `event`: `event`
   - `body`: `summary`. 비어 있으면 넣지 않는다.
   - `comments[]`
     - `path`, `line`, `side: "RIGHT"`
     - `startLine`이 있으면 `start_line`과 `start_side: "RIGHT"`
     - `body`: `**[<severity>]** <body>`. `suggestion`이 있으면 빈 줄 하나 뒤에 아래 블록을 붙인다.
       ````
       ```suggestion
       <suggestion>
       ```
       ````
4. 게시한다.
   ```bash
   gh api repos/<repo>/pulls/<number>/reviews --method POST --input <임시 파일> --jq .html_url
   ```
5. 성공하면 `show_done`에 리뷰 URL을 넘기고, 사용자에게도 URL을 알린다.
6. 실패하면 `gh`의 오류 메시지를 그대로 보여 주고, 게시하려던 피드백 내용을 대화에 남겨 직접 옮길 수 있게 한다. 줄 위치 오류이거나 PR에 새 커밋이 올라온 경우라면, 다시 리뷰할지 묻는다.

## 5. 취소

`[리뷰 패널] 취소` 메시지를 받으면 아무것도 게시하지 않고, 리뷰를 취소했다고 한 줄로 알린다.
