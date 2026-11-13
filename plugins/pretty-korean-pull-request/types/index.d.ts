export type Severity = '버그' | '제안' | '질문' | '사소'

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'

export type PullRequest = {
  number: number
  title: string
  author: string
  additions: number
  deletions: number
  isReviewRequested: boolean
}

export type Feedback = {
  id: number
  severity: Severity
  path: string
  line: number
  startLine?: number
  body: string
  suggestion?: string
}

export type Review = {
  repo: string
  number: number
  title: string
  headSha: string
  isOwnPr: boolean
  summary: string
  recommendedEvent: ReviewEvent
  items: Feedback[]
}

export type Draft = {
  selected: Record<string, boolean>
  bodies: Record<string, string>
  suggestions: Record<string, string>
  summary: string
  event: ReviewEvent
  expanded: number
}

export type Screen = 'idle' | 'list' | 'reviewing' | 'feedback' | 'posting' | 'done'

export type Panel = {
  screen: Screen
  repo: string
  prs: PullRequest[]
  target?: { number: number; title: string }
  review?: Review
  draft?: Draft
  resultUrl?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pretty-korean-pull-request': { panel: Shaped<Panel> }
  }
}
