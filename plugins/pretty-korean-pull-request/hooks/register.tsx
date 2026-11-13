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

const PANE = 'review'
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
      description: 'pretty-korean-pull-request:review 스킬 전용. 리뷰 패널에 리뷰 중 화면을 보여 준다.',
      inputSchema: {
        type: 'object',
        required: ['number', 'title'],
        properties: { number: { type: 'integer' }, title: { type: 'string' } },
      },
    })
    await $.tool.register({
      name: 'show_feedback',
      description:
        'pretty-korean-pull-request:review 스킬 전용. 리뷰 패널에 피드백 편집 화면을 보여 준다. 사용자가 게시하면 "[리뷰 패널] 게시 요청" 메시지와 JSON이, 취소하면 "[리뷰 패널] 취소" 메시지가 온다.',
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
    await $.ui.open({ id: PANE, title: `열린 PR (${input.prs.length})`, focus: true })

    return { result: `패널에 PR ${input.prs.length}개를 표시했습니다. 사용자의 선택을 기다립니다.` }
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_reviewing' }, async ($, e) => {
    const input = e as unknown as { number: number; title: string }
    await update($, panel, (state): Panel => ({ ...state, screen: 'reviewing', target: input }))
    await $.ui.open({ id: PANE, title: `리뷰 중: #${input.number}` })

    return { result: '패널에 리뷰 중 화면을 표시했습니다.' }
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
    await $.ui.open({ id: PANE, title: `리뷰: #${clean.number}`, focus: true })

    return { result: `패널에 피드백 ${clean.items.length}개를 표시했습니다. 사용자의 게시나 취소를 기다립니다.` }
  })

  on('tool.call', { tool: 'mcp__pretty-korean-pull-request__show_done' }, async ($, e) => {
    const input = e as unknown as { url: string }
    await update($, panel, (state): Panel => ({ ...state, screen: 'done', resultUrl: input.url }))

    return { result: '패널에 완료 화면을 표시했습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const state = await read($, panel)
    const rows = e.viewport?.rows ?? 24

    const send = (text: string) => void $.prompt.submit({ text })
    const setDraft = (fn: (draft: Draft) => Draft) =>
      void update($, panel, (current): Panel => (current.draft ? { ...current, draft: fn(current.draft) } : current))

    if (state.screen === 'list') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{state.repo}  Enter로 리뷰할 PR을 고릅니다.</Text>
          {state.prs.map(pr => (
            <Button
              key={`pr:${pr.number}`}
              plain
              onPress={() => {
                void update($, panel, (current): Panel => ({
                  ...current,
                  screen: 'reviewing',
                  target: { number: pr.number, title: pr.title },
                }))
                send(`${PREFIX} PR #${pr.number} 선택`)
              }}
            >
              #{pr.number} {pr.title} <Text dimColor>@{pr.author} +{pr.additions} -{pr.deletions}</Text>
              {pr.isReviewRequested ? <Text color="yellow"> 리뷰 요청됨</Text> : ''}
            </Button>
          ))}
        </Box>
      )
    }

    if (state.screen === 'reviewing' || state.screen === 'posting') {
      const label = state.screen === 'reviewing' ? '리뷰하고 있습니다' : '게시하고 있습니다'

      return (
        <Box flexDirection="column">
          <Text>
            #{state.target?.number ?? state.review?.number} {state.target?.title ?? state.review?.title}
          </Text>
          <Text dimColor>{label}...</Text>
        </Box>
      )
    }

    if (state.screen === 'done') {
      return (
        <Box flexDirection="column">
          <Text>리뷰를 게시했습니다.</Text>
          <Text dimColor>{state.resultUrl ?? ''}</Text>
        </Box>
      )
    }

    if (state.screen !== 'feedback' || !state.review || !state.draft) {
      return <Text dimColor>리뷰할 PR이 없습니다.</Text>
    }

    const { review, draft } = state
    const count = review.items.filter(item => draft.selected[item.id]).length
    // 피드백마다 머리줄, 본문, 제안 코드, 여백을 합친 높이로 전부 펼칠 수 있는지 판단한다.
    const perItem = 1 + BODY_ROWS + SUGGESTION_ROWS + 2
    const isCompact = review.items.length * perItem + 12 > rows

    return (
      <Box flexDirection="column" gap={1}>
        {review.items.map(item => {
          const isOpen = !isCompact || draft.expanded === item.id
          const body = draft.bodies[item.id] ?? ''

          return (
            <Box key={`item:${item.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`toggle:${item.id}`}
                  plain
                  onPress={() =>
                    setDraft(current => ({
                      ...current,
                      selected: { ...current.selected, [item.id]: !current.selected[item.id] },
                    }))
                  }
                >
                  {draft.selected[item.id] ? '[x]' : '[ ]'}
                </Button>
                <Button
                  key={`open:${item.id}`}
                  plain
                  onPress={() => setDraft(current => ({ ...current, expanded: item.id }))}
                >
                  {item.severity} <Text dimColor>{location(item)}</Text>
                </Button>
              </Box>
              {isOpen ? (
                <Box flexDirection="column">
                  <Input
                    key={`body:${item.id}`}
                    label="본문"
                    rows={BODY_ROWS}
                    value={body}
                    submitLabel="다음"
                    onInput={value => setDraft(current => ({ ...current, bodies: { ...current.bodies, [item.id]: value } }))}
                    onSubmit={value => setDraft(current => ({ ...current, bodies: { ...current.bodies, [item.id]: value } }))}
                  />
                  <Input
                    key={`suggestion:${item.id}`}
                    label="제안"
                    rows={SUGGESTION_ROWS}
                    placeholder="제안 코드 없음"
                    value={draft.suggestions[item.id] ?? ''}
                    submitLabel="다음"
                    onInput={value =>
                      setDraft(current => ({ ...current, suggestions: { ...current.suggestions, [item.id]: value } }))
                    }
                    onSubmit={value =>
                      setDraft(current => ({ ...current, suggestions: { ...current.suggestions, [item.id]: value } }))
                    }
                  />
                </Box>
              ) : (
                <Text dimColor wrap="truncate-end">
                  {body.split('\n')[0]}
                </Text>
              )}
            </Box>
          )
        })}
        <Input
          key="summary"
          label="총평"
          rows={2}
          placeholder="총평 없음"
          value={draft.summary}
          submitLabel="다음"
          onInput={value => setDraft(current => ({ ...current, summary: value }))}
          onSubmit={value => setDraft(current => ({ ...current, summary: value }))}
        />
        {review.isOwnPr ? (
          <Text dimColor>내 PR이라 코멘트로 게시합니다.</Text>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text>결과</Text>
            {EVENTS.map(one => (
              <Button
                key={`event:${one.value}`}
                plain
                onPress={() => setDraft(current => ({ ...current, event: one.value }))}
              >
                {draft.event === one.value ? `(o) ${one.label}` : `( ) ${one.label}`}
                {review.recommendedEvent === one.value ? <Text dimColor> 추천</Text> : ''}
              </Button>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          <Button
            key="publish"
            variant="primary"
            onPress={() => {
              const request = publishRequest(review, draft)
              void update($, panel, (current): Panel => ({ ...current, screen: 'posting' }))
              send(`${PREFIX} 게시 요청\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\``)
            }}
          >
            {`게시 (${count}개)`}
          </Button>
          <Button
            key="cancel"
            onPress={() => {
              void update($, panel, (current): Panel => ({ ...current, screen: 'idle' }))
              send(`${PREFIX} 취소`)
            }}
          >
            취소
          </Button>
        </Box>
      </Box>
    )
  })
}
