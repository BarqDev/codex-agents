import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'codex-agents',
  component: 'Pane',
  requestId: 'codex-agents',
  props: {
    title: 'Codex agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW_S = 1_800_000_000
const FILES: Record<string, string> = {
  'r1/meta.json': JSON.stringify({ name: 'test-chat', model: 'gpt-6.1-sol', effort: 'high', sandbox: 'full', dir: '/proj', started: NOW_S - 75 }),
  'r1/status.json': JSON.stringify({ state: 'running' }),
  'r1/progress.log': '10:00:00 💬 Checking the chat page\n10:00:05 $ npx playwright test chat\n',
  'r2/meta.json': JSON.stringify({ name: 'write-tests', model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', dir: '/proj', started: NOW_S - 300 }),
  'r2/status.json': JSON.stringify({ state: 'failed', rc: 1, ended: NOW_S - 200 }),
  'r2/progress.log': '10:01:00 ⚠ something broke\n',
}

test('lists running and failed Codex runs with their latest step', async ($, on) => {
  on('command.register', () => ({ value: { command: 'codex-agents' } }))
  on('agent.register', () => ({ value: { agent: 'codex-agents:codex' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: NOW_S * 1000 })
  mock.env(on, { HOME: '/home/dev' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Ready', stderr: '' } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: ['r1', 'r2'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e: any) => {
    const hit = Object.keys(FILES).find(k => String(e.path).endsWith(k))
    return hit ? { value: FILES[hit] } : { error: 'missing' }
  })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 running/ }))?.text).toContain('1 finished')
    expect(await ui.find({ type: 'Text', text: /npx playwright test chat/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /exit 1/ })).toBeTruthy()
    await ui.unmount()
  }
})
