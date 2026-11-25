import { expect, test } from 'claude-code/testing'

import { fromApi, plan } from './subagent'

const user = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
const steps = { role: 'assistant' as const, text: '**Codex** · `gpt-6.2-sol` · high · read-only', toolUses: [] }
const handback = (message: string) => ({
  role: 'assistant' as const,
  text: '',
  toolUses: [{ tool_use_id: 'toolu_codex_1', tool: 'SubagentHandback', input: { message } }],
})
const result = { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_codex_1', text: 'ok' }] }
const answer = (text: string) => ({ role: 'assistant' as const, text, toolUses: [] })

test('first turn runs the task with the header flags', async () => {
  const p = plan([user('codex: -t terra -w\nFix the bug in app.py')] as never)
  expect(p).toEqual({ kind: 'run', flags: ['-t', 'terra', '-w'], task: 'Fix the bug in app.py', first: 'Fix the bug in app.py', followUp: false })
})

test('the step after the hand-back ends the turn with the answer', async () => {
  const p = plan([user('Read app.py'), steps, handback('app.py has 3 functions'), result] as never)
  expect(p).toEqual({ kind: 'end', answer: 'app.py has 3 functions' })
})

test('follow-ups after a finished turn run once, every message in order', async () => {
  const p = plan([
    user('codex: -w\nBuild the form'),
    steps,
    handback('Form built'),
    result,
    answer('Form built'),
    user('Also add validation'),
    user('Here is the design brief: blue buttons'),
  ] as never)
  expect(p?.kind).toBe('run')
  if (p?.kind !== 'run') return
  expect(p.flags).toEqual(['-w'])
  expect(p.task).toContain('Build the form')
  expect(p.task).toContain('Form built')
  expect(p.task).toContain('New messages, in the order they were sent (2):')
  expect(p.task.indexOf('1. Also add validation')).toBeLessThan(p.task.indexOf('2. Here is the design brief'))
})

test('a nag with nothing new hands the last answer back again', async () => {
  const p = plan([
    user('Read app.py'),
    steps,
    handback('done'),
    result,
    answer('done'),
    user('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback now.'),
  ] as never)
  expect(p).toEqual({ kind: 'again', answer: 'done' })
})

test('messages sent while Codex ran are read from the raw transcript, wrappers and reminders removed', async () => {
  const api = [
    { role: 'user', content: 'codex: -t luna\nList hooks' },
    { role: 'user', content: '<system-reminder> Your final report is delivered through SubagentHandback. </system-reminder>' },
    { role: 'assistant', content: [{ type: 'text', text: '**Codex** · `gpt-6-luna` · low · read-only' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: 'hooks: a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered' }] },
    {
      role: 'user',
      content:
        'The coordinator sent a message while you were working: Follow-up 1: count README lines. Address this before completing your current task.',
    },
    { role: 'user', content: '[handback-send-enforce] Your report has not been delivered.' },
    {
      role: 'user',
      content:
        'The coordinator sent a message while you were working: Follow-up 2: list scripts. Address this before completing your current task.',
    },
  ]
  const p = plan(fromApi(api))
  expect(p?.kind).toBe('run')
  if (p?.kind !== 'run') return
  expect(p.flags).toEqual(['-t', 'luna'])
  expect(p.task).toContain('New messages, in the order they were sent (2):')
  expect(p.task).toContain('1. Follow-up 1: count README lines.')
  expect(p.task).toContain('2. Follow-up 2: list scripts.')
  expect(p.task).not.toContain('handback-send-enforce')
  expect(p.task).not.toContain('coordinator')
})

test('the hand-back result with only engine reminders after it ends the turn', async () => {
  const p = plan(
    fromApi([
      { role: 'user', content: 'List hooks' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered' }] },
      { role: 'user', content: '<system-reminder>noted</system-reminder>' },
    ]),
  )
  expect(p).toEqual({ kind: 'end', answer: 'a.ts' })
})

test('messages sent while Codex ran come from the queue when the transcript does not show them', async () => {
  const transcript = [user('codex: -t luna\nList hooks'), steps, handback('hooks: a.ts'), result]
  expect(plan(transcript as never)).toEqual({ kind: 'end', answer: 'hooks: a.ts' })

  const p = plan(transcript as never, ['Follow-up 1: count README lines.', 'Follow-up 2: list scripts.'])
  expect(p?.kind).toBe('run')
  if (p?.kind !== 'run') return
  expect(p.followUp).toBe(true)
  expect(p.flags).toEqual(['-t', 'luna'])
  expect(p.task.indexOf('1. Follow-up 1: count README lines.')).toBeLessThan(p.task.indexOf('2. Follow-up 2: list scripts.'))
})

test('a queued message the transcript already shows is run once', async () => {
  const p = plan([user('List hooks'), steps, handback('a.ts'), result, answer('a.ts'), user('Also list scripts')] as never, [
    'Also list scripts',
  ])
  expect(p?.kind).toBe('run')
  if (p?.kind !== 'run') return
  expect(p.task).toContain('New message:')
  expect(p.task.split('Also list scripts').length - 1).toBe(1)
})

test('a relayed message merged into the first message stays out of the original task', async () => {
  const merged = user(
    'Run sleep 75 then list hooks.\nThe coordinator sent a message while you were working:\nFollow-up 1: count lines.\n\nAddress this before completing your current task.',
  )
  const p = plan([merged, steps, handback('hooks: a.ts'), result] as never, ['Follow-up 1: count lines.'])
  expect(p?.kind).toBe('run')
  if (p?.kind !== 'run') return
  expect(p.first).toBe('Run sleep 75 then list hooks.')
  expect(p.task).not.toContain('coordinator')
  expect(p.task).toContain('New message:\n\nFollow-up 1: count lines.')
})

test('the -U flag is kept for the wrapper', async () => {
  const p = plan([user('codex: -U -w -t terra\nMake a one-page summary.docx')] as never)
  expect(p?.kind === 'run' && p.flags).toEqual(['-U', '-w', '-t', 'terra'])
})

test('the -B flag is kept for the wrapper', async () => {
  const p = plan([user('codex: -B\nOpen my Shopify admin and read the order count')] as never)
  expect(p?.kind === 'run' && p.flags).toEqual(['-B'])
})
