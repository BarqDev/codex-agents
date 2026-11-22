import { expect, test } from 'claude-code/testing'

import { plan } from './subagent'

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
  expect(p).toEqual({ kind: 'run', flags: ['-t', 'terra', '-w'], task: 'Fix the bug in app.py', first: 'Fix the bug in app.py' })
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

test('nothing new to run is reported, not dropped', async () => {
  const p = plan([user('Read app.py'), steps, handback('done'), result, answer('done')] as never)
  expect(p).toBe(null)
})
