import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  Draft,
  Feedback,
  Panel,
  PullRequest,
  Review,
  ReviewEvent,
  Severity,
} from '../types'

const PREFIX = '[리뷰 패널]'

// 저장 형식이 바뀌면 shape 태그를 올린다. 예전 형식으로 저장된 값은 버려진다.
const initial: Panel = { screen: 'idle', repo: '', prs: [] }
const panel = atom({ plugin: 'pretty-korean-pull-request', key: 'panel' } as const, initial, {
  shape: 'panel-1',
})

const SEVERITIES: Severity[] = ['버그', '제안', '질문', '사소']
const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: '코멘트' },
  { value: 'REQUEST_CHANGES', label: '변경 요청' },
  { value: 'APPROVE', label: '승인' },
]
const BODY_ROWS = 3
const SUGGESTION_ROWS = 2
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

// 심각도 배지 색. 테마 키를 써서 밝은 테마와 어두운 테마에서 모두 읽히게 한다.
const BADGE: Record<Severity, string> = {
  버그: 'error',
  제안: 'suggestion',
  질문: 'warning',
  사소: 'inactive',
}

const FEEDBACK_SCHEMA = {
  type: 'object',
  required: ['id', 'severity', 'path', 'line', 'body'],
  properties: {
    id: { type: 'integer' },
    severity: { type: 'string', enum: SEVERITIES },
    path: { type: 'string' },
    line: { type: 'integer', description: 'diff 오른쪽(바뀐 뒤) 기준 줄 번호' },
    startLine: { type: 'integer', description: '여러 줄 피드백의 시작 줄' },
    body: { type: 'string' },
    suggestion: { type: 'string', description: 'startLine~line을 대체할 코드. 없으면 생략' },
  },
}

const location = (item: Feedback) =>
  item.startLine && item.startLine !== item.line
    ? `${item.path}:${item.startLine}-${item.line}`
    : `${item.path}:${item.line}`

export function draftOf(review: Review): Draft {
  const draft: Draft = {
    selected: {},
    bodies: {},
    suggestions: {},
    summary: review.summary,
    event: review.isOwnPr ? 'COMMENT' : review.recommendedEvent,
    expanded: review.items[0]?.id ?? 0,
  }
  for (const item of review.items) {
    draft.selected[item.id] = item.severity !== '사소'
    draft.bodies[item.id] = item.body
    draft.suggestions[item.id] = item.suggestion ?? ''
  }

  return draft
}

export function publishRequest(review: Review, draft: Draft) {
  const comments = review.items
    .filter(item => draft.selected[item.id])
    .map(item => {
      const suggestion = (draft.suggestions[item.id] ?? '').trimEnd()

      return {
        severity: item.severity,
        path: item.path,
        line: item.line,
        ...(item.startLine && item.startLine !== item.line ? { startLine: item.startLine } : {}),
        body: (draft.bodies[item.id] ?? '').trim(),
        ...(suggestion ? { suggestion } : {}),
      }
    })

  return {
    repo: review.repo,
    number: review.number,
    headSha: review.headSha,
    event: review.isOwnPr ? 'COMMENT' : draft.event,
    summary: draft.summary.trim(),
    comments,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_pr_list',
      description:
        'pretty-korean-pull-request:review 스킬 전용. 리뷰 패널을 열고 열린 PR 목록을 보여 준다. 사용자가 고르면 "[리뷰 패널] PR #<번호> 선택" 메시지가 온다.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'prs'],
        properties: {
          repo: { type: 'string', description: 'owner/name' },
          prs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['number', 'title', 'author', 'additions', 'deletions', 'isReviewRequested'],
              properties: {
                number: { type: 'integer' },
                title: { type: 'string' },
                author: { type: 'string' },
                additions: { type: 'integer' },
                deletions: { type: 'integer' },
                isReviewRequested: { type: 'boolean' },
              },
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'show_reviewing',
      description: 'pretty-korean-pull-request:review 스킬 전용. 리뷰 리뷰 밴드에 리뷰 중 화면을 보여 준다.',
      inputSchema: {
        type: 'object',
        required: ['number', 'title'],
        properties: { number: { type: 'integer' }, title: { type: 'string' } },
      },
    })
    await $.tool.register({
      name: 'show_feedback',
      description:
        'pretty-korean-pull-request:review 스킬 전용. 리뷰 리뷰 밴드에 피드백 편집 화면을 보여 준다. 사용자가 게시하면 "[리뷰 패널] 게시 요청" 메시지와 JSON이, 취소하면 "[리뷰 패널] 취소" 메시지가 온다.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'number', 'title', 'headSha', 'isOwnPr', 'summary', 'recommendedEvent', 'items'],
        properties: {
          repo: { type: 'string' },
          number: { type: 'integer' },
          title: { type: 'string' },
          headSha: { type: 'string' },
          isOwnPr: { type: 'boolean' },
          summary: { type: 'string' },
          recommendedEvent: { type: 'string', enum: EVENTS.map(one => one.value) },
          items: { type: 'array', items: FEEDBACK_SCHEMA },
        },
      },
    })
    await $.tool.register({
      name: 'show_done',
      description: 'pretty-korean-pull-request:review 스킬 전용. 리뷰 패널에 게시 완료 화면과 리뷰 URL을 보여 준다.',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
      },
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_pr_list' }, async ($, e) => {
    const input = e as unknown as { repo: string; prs: PullRequest[] }
    await update($, panel, (): Panel => ({ screen: 'list', repo: input.repo, prs: input.prs }))

    return { result: `리뷰 밴드에 PR ${input.prs.length}개를 표시했습니다. 사용자의 선택을 기다립니다.` }
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_reviewing' }, async ($, e) => {
    const input = e as unknown as { number: number; title: string }
    await update($, panel, (state): Panel => ({ ...state, screen: 'reviewing', target: input }))

    return { result: '리뷰 밴드에 리뷰 중 화면을 표시했습니다.' }
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_feedback' }, async ($, e) => {
    const review = e as unknown as Review
    const clean: Review = {
      repo: review.repo,
      number: review.number,
      title: review.title,
      headSha: review.headSha,
      isOwnPr: review.isOwnPr,
      summary: review.summary,
      recommendedEvent: review.recommendedEvent,
      items: review.items,
    }
    await update($, panel, (state): Panel => ({ ...state, screen: 'feedback', review: clean, draft: draftOf(clean) }))

    return { result: `리뷰 밴드에 피드백 ${clean.items.length}개를 표시했습니다. 사용자의 게시나 취소를 기다립니다.` }
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_done' }, async ($, e) => {
    const input = e as unknown as { url: string }
    await update($, panel, (state): Panel => ({ ...state, screen: 'done', resultUrl: input.url }))

    return { result: '리뷰 밴드에 완료 화면을 표시했습니다.' }
  })

  // 입력창 바로 위 밴드에 그린다. 비어 있는 입력창에서 숫자를 누르면 밴드의 버튼이 눌리고,
  // 글자 단축키와 본문 편집은 밴드에 포커스가 있을 때(ctrl+x tab 또는 클릭) 동작한다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, panel)
    if (state.screen === 'idle' || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const send = (text: string) => void $.prompt.submit({ text })
    const setDraft = (fn: (draft: Draft) => Draft) =>
      void update($, panel, (current): Panel => (current.draft ? { ...current, draft: fn(current.draft) } : current))
    const close = () => void update($, panel, (current): Panel => ({ ...current, screen: 'idle' }))
    const hotkey = (index: number) => (index < HOTKEYS.length ? { hotkey: HOTKEYS[index] } : {})

    const badge = (severity: Severity) => (
      <Text backgroundColor={BADGE[severity]} color="inverseText" bold>
        {` ${severity} `}
      </Text>
    )

    const frame = (title: string, right: string, body: any, footer: any) => (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold color="claude" wrap="truncate-end">
            {title}
          </Text>
          <Text dimColor>{right}</Text>
        </Box>
        <Box flexDirection="column" marginY={1}>
          {body}
        </Box>
        {footer}
      </Box>
    )

    const closeButton = <Button key="close" plain hotkey="x" label="닫기" onPress={close} />

    if (state.screen === 'list') {
      return frame(
        `PR 리뷰 · ${state.repo}`,
        `열린 PR ${state.prs.length}개`,
        state.prs.map((pr, index) => (
          <Button
            key={`pr:${pr.number}`}
            plain
            {...hotkey(index)}
            onPress={() => {
              void update($, panel, (current): Panel => ({
                ...current,
                screen: 'reviewing',
                target: { number: pr.number, title: pr.title },
              }))
              send(`${PREFIX} PR #${pr.number} 선택`)
            }}
          >
            <Text bold>#{pr.number}</Text> {pr.title}  <Text dimColor>@{pr.author}</Text>{' '}
            <Text color="diffAdded">+{pr.additions}</Text> <Text color="diffRemoved">-{pr.deletions}</Text>
            {pr.isReviewRequested ? <Text color="warning"> ● 리뷰 요청됨</Text> : ''}
          </Button>
        )),
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>숫자를 누르면 그 PR을 리뷰합니다.</Text>
          {closeButton}
        </Box>,
      )
    }

    if (state.screen === 'reviewing' || state.screen === 'posting') {
      const number = state.target?.number ?? state.review?.number
      const title = state.target?.title ?? state.review?.title ?? ''
      const label =
        state.screen === 'reviewing'
          ? '리뷰하고 있습니다. 바뀐 파일을 모두 읽고 있어요.'
          : '게시하고 있습니다.'

      return frame(
        `#${number} ${title}`,
        state.screen === 'reviewing' ? '리뷰 중' : '게시 중',
        <Text>
          <Text color="claude">● </Text>
          {label}
        </Text>,
        <Text dimColor>끝나면 이 자리에 결과가 나옵니다.</Text>,
      )
    }

    if (state.screen === 'done') {
      return frame(
        `#${state.review?.number ?? ''} ${state.review?.title ?? ''}`,
        '게시 완료',
        <Box flexDirection="column">
          <Text color="success" bold>
            ✓ 리뷰를 게시했습니다.
          </Text>
          <Text dimColor>{state.resultUrl ?? ''}</Text>
        </Box>,
        <Box flexDirection="row" justifyContent="flex-end">
          {closeButton}
        </Box>,
      )
    }

    if (state.screen !== 'feedback' || !state.review || !state.draft) {
      return next(e)
    }

    const { review, draft } = state
    const count = review.items.filter(item => draft.selected[item.id]).length
    const current = review.items.find(item => item.id === draft.expanded) ?? review.items[0]
    const toggle = (id: number) =>
      setDraft(one => ({ ...one, selected: { ...one.selected, [id]: !one.selected[id] } }))

    const list = review.items.map((item, index) => {
      const isOpen = current?.id === item.id

      return (
        <Box key={`item:${item.id}`} flexDirection="row" gap={1}>
          <Button key={`toggle:${item.id}`} plain onPress={() => toggle(item.id)}>
            {draft.selected[item.id] ? <Text color="success">[x]</Text> : <Text dimColor>[ ]</Text>}
          </Button>
          <Button
            key={`open:${item.id}`}
            plain
            {...hotkey(index)}
            onPress={() => setDraft(one => ({ ...one, expanded: item.id }))}
          >
            {badge(item.severity)} <Text bold={isOpen} dimColor={!draft.selected[item.id]}>{location(item)}</Text>
            {isOpen ? <Text color="claude"> ◀</Text> : ''}
          </Button>
        </Box>
      )
    })

    const detail = current ? (
      <Box
        key={`detail:${current.id}`}
        flexDirection="column"
        borderStyle="single"
        borderColor={BADGE[current.severity]}
        paddingX={1}
        marginTop={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            {badge(current.severity)} <Text bold>{location(current)}</Text>
          </Text>
          <Button key="toggle-current" plain hotkey="s" onPress={() => toggle(current.id)}>
            {draft.selected[current.id] ? '선택 해제' : '선택'}
          </Button>
        </Box>
        <Input
          key={`body:${current.id}`}
          label="본문"
          rows={BODY_ROWS}
          value={draft.bodies[current.id] ?? ''}
          submitLabel="다음"
          onInput={value => setDraft(one => ({ ...one, bodies: { ...one.bodies, [current.id]: value } }))}
          onSubmit={value => setDraft(one => ({ ...one, bodies: { ...one.bodies, [current.id]: value } }))}
        />
        <Input
          key={`suggestion:${current.id}`}
          label="제안 코드"
          rows={SUGGESTION_ROWS}
          placeholder="제안 코드 없음"
          value={draft.suggestions[current.id] ?? ''}
          submitLabel="다음"
          onInput={value => setDraft(one => ({ ...one, suggestions: { ...one.suggestions, [current.id]: value } }))}
          onSubmit={value => setDraft(one => ({ ...one, suggestions: { ...one.suggestions, [current.id]: value } }))}
        />
      </Box>
    ) : (
      <Text dimColor>찾은 피드백이 없습니다. 총평만 게시할 수 있습니다.</Text>
    )

    const EVENT_KEYS: Record<ReviewEvent, string> = { COMMENT: 'c', REQUEST_CHANGES: 'r', APPROVE: 'v' }
    const events = review.isOwnPr ? (
      <Text dimColor>결과  내 PR이라 코멘트로 게시합니다.</Text>
    ) : (
      <Box flexDirection="row" gap={2}>
        <Text bold>결과</Text>
        {EVENTS.map(one => (
          <Button
            key={`event:${one.value}`}
            plain
            hotkey={EVENT_KEYS[one.value]}
            onPress={() => setDraft(d => ({ ...d, event: one.value }))}
          >
            {draft.event === one.value ? <Text color="claude">(o) {one.label}</Text> : `( ) ${one.label}`}
            {review.recommendedEvent === one.value ? <Text dimColor> 추천</Text> : ''}
          </Button>
        ))}
      </Box>
    )

    return frame(
      `#${review.number} ${review.title}`,
      `${review.items.length}개 중 ${count}개 선택`,
      <Box flexDirection="column">
        {list}
        {detail}
        <Box flexDirection="column" marginTop={1}>
          {events}
          <Input
            key="summary"
            label="총평"
            rows={2}
            placeholder="총평 없음"
            value={draft.summary}
            submitLabel="다음"
            onInput={value => setDraft(d => ({ ...d, summary: value }))}
            onSubmit={value => setDraft(d => ({ ...d, summary: value }))}
          />
        </Box>
      </Box>,
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>숫자 펼치기 · ctrl+x tab으로 들어가 편집</Text>
        <Box flexDirection="row" gap={2}>
          <Button
            key="publish"
            variant="primary"
            hotkey="a"
            onPress={() => {
              const request = publishRequest(review, draft)
              void update($, panel, (one): Panel => ({ ...one, screen: 'posting' }))
              send(`${PREFIX} 게시 요청\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\``)
            }}
          >
            {`게시 (${count}개)`}
          </Button>
          <Button
            key="cancel"
            hotkey="x"
            onPress={() => {
              close()
              send(`${PREFIX} 취소`)
            }}
          >
            취소
          </Button>
        </Box>
      </Box>,
    )
  })
}
