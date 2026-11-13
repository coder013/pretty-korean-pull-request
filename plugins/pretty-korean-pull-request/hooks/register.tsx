import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  Draft,
  EditField,
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
  shape: 'panel-2',
})

// 리뷰하는 동안 부른 도구 호출의 id. 대화창에서 이 줄들을 숨긴다(ctrl+o로는 볼 수 있다).
const hidden = atom({ plugin: 'pretty-korean-pull-request', key: 'hidden' } as const, [] as string[], {
  shape: 'hidden-1',
})
const OWN_TOOL = 'mcp__pretty-korean-pull-request__'
const BUSY: Panel['screen'][] = ['reviewing', 'posting']

function isQuiet(tool: string, id: string | undefined, ids: readonly string[]) {
  return tool.startsWith(OWN_TOOL) || (id !== undefined && ids.includes(id))
}

const SEVERITIES: Severity[] = ['버그', '제안', '질문', '사소']
const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: '코멘트' },
  { value: 'REQUEST_CHANGES', label: '변경 요청' },
  { value: 'APPROVE', label: '승인' },
]

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

// 빈 입력창에서 누른 키 하나를 패널 동작으로 바꾼다. 패널이 받지 않는 키면 null.
// 상태를 바꾸는 일과, 대화에 보낼 메시지(send)나 입력창에 채울 글(fill)을 함께 돌려준다.
export type KeyResult = { state: Panel; send?: string; fill?: string }

const EDIT_LABEL: Record<EditField, string> = { body: '본문', suggestion: '제안 코드', summary: '총평' }

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

export function pressKey(state: Panel, key: string): KeyResult | null {
  const down = key === 's' || key === 'j' || key === 'down'
  const up = key === 'w' || key === 'k' || key === 'up'
  const side = key === 'a' ? -1 : key === 'd' ? 1 : 0
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1
  const base: Panel = { ...state, editing: undefined }

  if (state.screen === 'list') {
    const cursor = state.cursor ?? 0
    const pick = (index: number): KeyResult | null => {
      const pr = state.prs[index]
      if (!pr) {
        return null
      }

      return {
        state: { ...base, cursor: index, screen: 'reviewing', target: { number: pr.number, title: pr.title } },
        send: `${PREFIX} PR #${pr.number} 선택`,
      }
    }
    if (down || up) {
      return { state: { ...base, cursor: clamp(cursor + (down ? 1 : -1), state.prs.length) } }
    }
    if (key === ' ' || key === 'return' || key === 'l') {
      return pick(cursor)
    }
    if (digit >= 0) {
      return pick(digit)
    }
    if (key === 'q' || key === 'x') {
      return { state: { ...base, screen: 'idle' } }
    }

    return null
  }

  if (state.screen === 'done') {
    return key === 'q' || key === 'x' ? { state: { ...base, screen: 'idle' } } : null
  }

  if (state.screen !== 'feedback' || !state.review || !state.draft) {
    return null
  }

  const { review, draft } = state
  const ids = review.items.map(item => item.id)
  const index = Math.max(0, ids.indexOf(draft.expanded))
  const current = ids[index]
  const withDraft = (next: Partial<Draft>): Panel => ({ ...base, draft: { ...draft, ...next } })
  const edit = (field: EditField, id: number, text: string): KeyResult => ({
    state: { ...base, editing: { field, id } },
    fill: text,
  })

  if ((down || up) && ids.length > 0) {
    return { state: withDraft({ expanded: ids[clamp(index + (down ? 1 : -1), ids.length)]! }) }
  }
  if (digit >= 0 && ids[digit] !== undefined) {
    return { state: withDraft({ expanded: ids[digit]! }) }
  }
  if (key === ' ' && current !== undefined) {
    return { state: withDraft({ selected: { ...draft.selected, [current]: !draft.selected[current] } }) }
  }
  if (key === 'e' && current !== undefined) {
    return edit('body', current, draft.bodies[current] ?? '')
  }
  if (key === 'f' && current !== undefined) {
    return edit('suggestion', current, draft.suggestions[current] ?? '')
  }
  if (key === 'z' && current !== undefined) {
    return { state: withDraft({ suggestions: { ...draft.suggestions, [current]: '' } }) }
  }
  if (key === 't') {
    return edit('summary', 0, draft.summary)
  }
  if (side !== 0 && !review.isOwnPr) {
    const at = EVENTS.findIndex(one => one.value === draft.event)

    return { state: withDraft({ event: EVENTS[clamp(at + side, EVENTS.length)]!.value }) }
  }
  if (key === 'p') {
    const request = publishRequest(review, draft)

    return {
      state: { ...base, screen: 'posting' },
      send: `${PREFIX} 게시 요청\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\``,
    }
  }
  if (key === 'q' || key === 'x') {
    return { state: { ...base, screen: 'idle' }, send: `${PREFIX} 취소` }
  }

  return null
}

// 입력창에서 고친 글을 편집 중인 칸에 넣는다.
export function saveEdit(state: Panel, text: string): Panel {
  if (!state.editing || !state.draft) {
    return state
  }
  const { field, id } = state.editing
  const draft = state.draft
  const next: Draft =
    field === 'summary'
      ? { ...draft, summary: text }
      : field === 'body'
        ? { ...draft, bodies: { ...draft.bodies, [id]: text } }
        : { ...draft, suggestions: { ...draft.suggestions, [id]: text } }

  return { ...state, editing: undefined, draft: next }
}

// 커서가 보이도록 목록에서 보여 줄 구간을 고른다.
function windowOf(length: number, cursor: number, size: number) {
  if (length <= size) {
    return [0, length] as const
  }
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), length - size))

  return [start, start + size] as const
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

  // 리뷰하는 동안 부른 도구를 기록해 둔다. 대화창에서 숨길 줄을 고르는 데 쓴다.
  on('tool.call', async ($, e, next) => {
    const id = (e as { tool_use_id?: string }).tool_use_id
    if (id && BUSY.includes((await read($, panel)).screen)) {
      await update($, hidden, ids => [...ids.slice(-500), id])
    }

    return next(e)
  })

  // 필요한 내용은 밴드에 다 있으므로, 패널 도구와 리뷰 중 도구 호출, 패널이 보낸 메시지는 대화창에 그리지 않는다.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded || !isQuiet(e.props.tool, e.props.tool_use_id, await read($, hidden))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded || !isQuiet(e.props.tool, e.props.tool_use_id, await read($, hidden))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.calls.length === 0) {
      return next(e)
    }
    const ids = await read($, hidden)
    if (!e.props.calls.every(call => isQuiet(call.tool, call.tool_use_id, ids))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    const isOurs =
      origin.kind === 'plugin' && origin.name === 'pretty-korean-pull-request' && e.props.text.startsWith(PREFIX)
    if (e.props.isExpanded || !isOurs) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })
  // 패널이 열려 있고 입력창이 비어 있으면, 누른 키를 패널이 받는다(입력창에는 들어가지 않는다).
  on('prompt.edit', async ($, e, next) => {
    if (e.text !== '' || !e.key || e.key.ctrl || e.key.meta) {
      return next(e)
    }
    const result = pressKey(await read($, panel), e.key.key)
    if (!result) {
      return next(e)
    }
    await update($, panel, () => result.state)
    if (result.send) {
      void $.prompt.submit({ text: result.send })
    }

    // 편집을 시작하는 키면 그 칸의 글을 입력창에 채우고, 아니면 키를 입력창에 넣지 않는다.
    return result.fill !== undefined
      ? { text: result.fill, cursor: result.fill.length }
      : { text: e.text, cursor: e.cursor }
  })

  // 편집 중에 Enter를 누르면, 입력창의 글을 그 칸에 넣고 대화에는 보내지 않는다.
  on('prompt.submit', async ($, e, next) => {
    const state = await read($, panel)
    if (!state.editing || e.origin.kind !== 'composer') {
      return next(e)
    }
    await update($, panel, current => saveEdit(current, e.text.trimEnd()))

    return { text: e.text }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, panel)
    if (state.screen === 'idle' || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    // 테두리, 제목, 여백, 안내 줄을 뺀 나머지 줄 수
    const room = Math.max(4, e.props.maxRows - 6)
    const act = (key: string) => {
      const result = pressKey(state, key)
      if (!result) {
        return
      }
      void update($, panel, () => result.state)
      if (result.fill !== undefined) {
        void $.prompt.fill({ text: result.fill })
      }
      if (result.send) {
        void $.prompt.submit({ text: result.send })
      }
    }

    const badge = (severity: Severity) => (
      <Text backgroundColor={BADGE[severity]} color="inverseText" bold>
        {` ${severity} `}
      </Text>
    )
    const keys = (pairs: [string, string][]) => (
      <Text dimColor wrap="wrap">
        {pairs.map(([key, label], index) => (
          <Text key={key}>
            {index > 0 ? '  ' : ''}
            <Text color="claude" bold>
              {key}
            </Text>{' '}
            {label}
          </Text>
        ))}
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

    if (state.screen === 'list') {
      const cursor = state.cursor ?? 0
      const [from, to] = windowOf(state.prs.length, cursor, room)

      return frame(
        `PR 리뷰 · ${state.repo}`,
        `${cursor + 1} / ${state.prs.length}`,
        state.prs.slice(from, to).map((pr, offset) => {
          const index = from + offset
          const isCursor = index === cursor

          return (
            <Button key={`pr:${pr.number}`} plain onPress={() => act(String(index + 1))}>
              <Text color="claude">{isCursor ? '❯ ' : '  '}</Text>
              <Text dimColor>{index < 9 ? `${index + 1} ` : '  '}</Text>
              <Text bold={isCursor} inverse={isCursor}>
                {` #${pr.number} ${pr.title} `}
              </Text>{' '}
              <Text dimColor>@{pr.author}</Text> <Text color="diffAdded">+{pr.additions}</Text>{' '}
              <Text color="diffRemoved">-{pr.deletions}</Text>
              {pr.isReviewRequested ? <Text color="warning"> ● 리뷰 요청됨</Text> : ''}
            </Button>
          )
        }),
        <Box flexDirection="row" justifyContent="space-between">
          {keys([
            ['w/s', '이동'],
            ['space', '리뷰 시작'],
            ['1-9', '바로 선택'],
            ['q', '닫기'],
          ])}
          <Button key="close" plain label="닫기" onPress={() => act('q')} />
        </Box>,
      )
    }

    if (state.screen === 'reviewing' || state.screen === 'posting') {
      const number = state.target?.number ?? state.review?.number
      const title = state.target?.title ?? state.review?.title ?? ''

      return frame(
        `#${number} ${title}`,
        state.screen === 'reviewing' ? '리뷰 중' : '게시 중',
        <Text>
          <Text color="claude">● </Text>
          {state.screen === 'reviewing' ? '리뷰하고 있습니다. 바뀐 파일을 모두 읽고 있어요.' : '게시하고 있습니다.'}
        </Text>,
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>끝나면 이 자리에 결과가 나옵니다.</Text>
          <Button key="close" plain label="닫기" onPress={() => void update($, panel, (one): Panel => ({ ...one, screen: 'idle' }))} />
        </Box>,
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
        <Box flexDirection="row" justifyContent="space-between">
          {keys([['q', '닫기']])}
          <Button key="close" plain label="닫기" onPress={() => act('q')} />
        </Box>,
      )
    }

    if (state.screen !== 'feedback' || !state.review || !state.draft) {
      return next(e)
    }

    const { review, draft } = state
    const count = review.items.filter(item => draft.selected[item.id]).length
    const index = Math.max(0, review.items.findIndex(item => item.id === draft.expanded))
    const current = review.items[index]
    const editing = state.editing
    // 목록에는 남는 줄의 3분의 1까지 쓰고, 나머지는 펼친 피드백에 쓴다.
    const [from, to] = windowOf(review.items.length, index, Math.max(3, Math.floor(room / 3)))

    const list = review.items.slice(from, to).map((item, offset) => {
      const isCursor = from + offset === index
      const isOn = draft.selected[item.id]

      return (
        <Button key={`open:${item.id}`} plain onPress={() => act(String(from + offset + 1))}>
          <Text color="claude">{isCursor ? '❯ ' : '  '}</Text>
          {isOn ? <Text color="success">◉ </Text> : <Text dimColor>○ </Text>}
          {badge(item.severity)}{' '}
          <Text bold={isCursor} dimColor={!isOn} wrap="truncate-end">
            {location(item)}
          </Text>
        </Button>
      )
    })

    const field = (name: EditField, label: string, text: string, empty: string) => {
      const isEditing = editing?.field === name && (name === 'summary' || editing.id === current?.id)

      return (
        <Box flexDirection="column">
          <Text color={isEditing ? 'claude' : undefined} bold>
            {label}
            {isEditing ? '  ✎ 입력창에서 고치는 중 · Enter 저장' : ''}
          </Text>
          <Text dimColor={!text} wrap="wrap">
            {text || empty}
          </Text>
        </Box>
      )
    }

    const detail = current ? (
      <Box
        key={`detail:${current.id}`}
        flexDirection="column"
        borderStyle="single"
        borderColor={BADGE[current.severity]}
        paddingX={1}
        marginTop={1}
        gap={1}
      >
        <Text>
          {badge(current.severity)} <Text bold>{location(current)}</Text>
          {draft.selected[current.id] ? <Text color="success">  게시함</Text> : <Text dimColor>  게시 안 함</Text>}
        </Text>
        {field('body', '본문 (e)', draft.bodies[current.id] ?? '', '본문 없음')}
        {field('suggestion', '제안 코드 (f 고치기 · z 지우기)', draft.suggestions[current.id] ?? '', '제안 코드 없음')}
      </Box>
    ) : (
      <Text dimColor>찾은 피드백이 없습니다. 총평만 게시할 수 있습니다.</Text>
    )

    const events = review.isOwnPr ? (
      <Text dimColor>결과  내 PR이라 코멘트로 게시합니다.</Text>
    ) : (
      <Box flexDirection="row" gap={2}>
        <Text bold>결과</Text>
        {EVENTS.map(one => (
          <Button
            key={`event:${one.value}`}
            plain
            onPress={() => void update($, panel, (now): Panel => (now.draft ? { ...now, draft: { ...now.draft, event: one.value } } : now))}
          >
            {draft.event === one.value ? <Text color="claude">(o) {one.label}</Text> : `( ) ${one.label}`}
            {review.recommendedEvent === one.value ? <Text dimColor> · 추천</Text> : ''}
          </Button>
        ))}
        <Text dimColor>a/d</Text>
      </Box>
    )

    return frame(
      `#${review.number} ${review.title}`,
      `${review.items.length}개 중 ${count}개 게시`,
      <Box flexDirection="column">
        {list}
        {detail}
        <Box flexDirection="column" marginTop={1} gap={1}>
          {events}
          {field('summary', '총평 (t)', draft.summary, '총평 없음')}
        </Box>
      </Box>,
      <Box flexDirection="column">
        {keys([
          ['w/s', '이동'],
          ['a/d', '결과'],
          ['space', '게시 여부'],
          ['e', '본문'],
          ['f', '제안 코드'],
          ['t', '총평'],
          ['p', `게시 (${count}개)`],
          ['q', '취소'],
        ])}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="publish" variant="primary" onPress={() => act('p')}>
            {`게시 (${count}개)`}
          </Button>
          <Button key="cancel" onPress={() => act('x')}>
            취소
          </Button>
        </Box>
      </Box>,
    )
  })
}
