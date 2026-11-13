import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pretty-korean-pull-request',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 40,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PRS = [
  { number: 940, title: '회원 탈퇴 API 추가', author: 'alice', additions: 120, deletions: 30, isReviewRequested: true },
  { number: 937, title: '주문 번호 중복 차단', author: 'bob', additions: 40, deletions: 5, isReviewRequested: false },
]

const REVIEW = {
  repo: 'acme/app',
  number: 940,
  title: '회원 탈퇴 API 추가',
  headSha: 'abc123',
  isOwnPr: false,
  summary: '전반적으로 깔끔합니다.',
  recommendedEvent: 'REQUEST_CHANGES',
  items: [
    { id: 1, severity: '버그', path: 'src/A.kt', line: 42, body: '이 코드는 A로 고쳐야 해요.', suggestion: 'val t = list.firstOrNull()' },
    { id: 2, severity: '제안', path: 'src/B.kt', line: 10, startLine: 8, body: '함수로 분리하면 읽기 쉽습니다.' },
    { id: 3, severity: '사소', path: 'README.md', line: 3, body: '오타가 있습니다.' },
  ],
}

// 엔진 대신 응답하는 hook을 깔고, 패널이 대화에 보낸 메시지를 모은다.
async function setUp($: any, on: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const sent: string[] = []
  on('tool.register', (_: unknown, e: { name: string }) => ({
    value: { tool: `mcp__pretty-korean-pull-request__${e.name}` },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)

    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface, isInteractive: true })

  return sent
}

const callTool = ($: any, name: string, input: object) =>
  $.tool.call({ tool: `mcp__pretty-korean-pull-request__${name}`, tool_use_id: name, ...input })

const publishedJson = (text: string) => JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!)

test('PR 목록을 보여 주고, 고르면 선택 메시지를 보낸다', async ($, on) => {
  const sent = await setUp($, on)
  const answer = await callTool($, 'show_pr_list', { repo: 'acme/app', prs: PRS })
  expect(String((answer as { result: unknown }).result)).toContain('2개')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /#940/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /리뷰 요청됨/ })).toBeDefined()

  await ui.press({ key: 'pr:940' })
  expect(sent).toEqual(['[리뷰 패널] PR #940 선택'])
  expect(await ui.find({ type: 'Text', text: /리뷰하고 있습니다/ })).toBeDefined()
  await ui.unmount()
})

test('리뷰 중 화면과 완료 화면으로 바뀐다', async ($, on) => {
  await setUp($, on)
  await callTool($, 'show_reviewing', { number: 940, title: '회원 탈퇴 API 추가' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /리뷰하고 있습니다/ })).toBeDefined()
  await ui.unmount()

  await callTool($, 'show_done', { url: 'https://github.com/acme/app/pull/940#pullrequestreview-1' })
  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /pullrequestreview-1/ })).toBeDefined()
  await done.unmount()
})

test('사소만 선택 해제하고, 고친 내용을 그대로 게시 요청에 담는다', async ($, on) => {
  const sent = await setUp($, on)
  await callTool($, 'show_feedback', REVIEW)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'toggle:1' }))?.text).toContain('[x]')
  expect((await ui.find({ key: 'toggle:2' }))?.text).toContain('[x]')
  expect((await ui.find({ key: 'toggle:3' }))?.text).toContain('[ ]')
  expect((await ui.find({ key: 'publish' }))?.text).toContain('2개')

  await ui.input({ key: 'body:1', text: '이 코드는 A 방법으로 변경하는 건 어떻게 생각하세요?', kind: 'change' })
  await ui.input({ key: 'suggestion:1', text: '', kind: 'change' })
  await ui.press({ key: 'toggle:3' })
  await ui.press({ key: 'event:COMMENT' })
  await ui.input({ key: 'summary', text: '', kind: 'change' })
  await ui.press({ key: 'publish' })

  expect(sent).toHaveLength(1)
  expect(sent[0]!.startsWith('[리뷰 패널] 게시 요청')).toBe(true)
  const request = publishedJson(sent[0]!)
  expect(request.event).toBe('COMMENT')
  expect(request.summary).toBe('')
  expect(request.headSha).toBe('abc123')
  expect(request.comments).toHaveLength(3)
  expect(request.comments[0]).toEqual({
    severity: '버그',
    path: 'src/A.kt',
    line: 42,
    body: '이 코드는 A 방법으로 변경하는 건 어떻게 생각하세요?',
  })
  expect(request.comments[1].startLine).toBe(8)
  await ui.unmount()
})

test('추천 결과가 미리 선택되고, 내 PR이면 코멘트로 고정된다', async ($, on) => {
  const sent = await setUp($, on)
  await callTool($, 'show_feedback', REVIEW)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'event:REQUEST_CHANGES' }))?.text).toContain('(o)')
  await ui.unmount()

  await callTool($, 'show_feedback', { ...REVIEW, isOwnPr: true })
  const own = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await own.find({ key: 'event:APPROVE' })).toBeUndefined()
  expect(await own.find({ type: 'Text', text: /내 PR이라 코멘트로/ })).toBeDefined()
  await own.press({ key: 'publish' })
  expect(publishedJson(sent[0]!).event).toBe('COMMENT')
  await own.unmount()
})

test('취소하면 취소 메시지만 보낸다', async ($, on) => {
  const sent = await setUp($, on)
  await callTool($, 'show_feedback', REVIEW)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'cancel' })
  expect(sent).toEqual(['[리뷰 패널] 취소'])
  await ui.unmount()
})

test('펼친 피드백 하나만 편집 칸을 보여 준다', async ($, on) => {
  await setUp($, on)
  await callTool($, 'show_feedback', REVIEW)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { rows: 20, columns: 100 } })
  expect(await ui.find({ key: 'body:1' })).toBeDefined()
  expect(await ui.find({ key: 'body:2' })).toBeUndefined()

  await ui.press({ key: 'open:2' })
  expect(await ui.find({ key: 'body:1' })).toBeUndefined()
  expect(await ui.find({ key: 'body:2' })).toBeDefined()
  await ui.unmount()
})

test('리뷰 중이 아니면 밴드를 그리지 않고, 닫으면 사라진다', async ($, on) => {
  await setUp($, on)
  const idle = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await idle.keepsBeneath()).toBe(true)
  await idle.unmount()

  await callTool($, 'show_pr_list', { repo: 'acme/app', prs: PRS })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.keepsBeneath()).toBe(false)
  await ui.press({ key: 'close' })
  expect(await ui.keepsBeneath()).toBe(true)
  await ui.unmount()
})
