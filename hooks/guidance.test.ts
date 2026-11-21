import { expect, test } from 'claude-code/testing'

test('adds the Codex guidance to the system prompt, pointing at the bundled wrapper', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))

  const model = 'claude-sonnet-5-5'
  const { sections } = await $.prompt.compose({
    model,
    promptModel: model,
    surfaces: ['terminal'],
    tools: ['Agent', 'Bash'],
    outputStyle: null,
    traits: [],
  })
  const added = sections.find(s => s.id === 'codex-agents:guidance')

  expect(sections[0]?.id).toBe('intro')
  expect(added?.scope).toBe('session')
  expect(added?.text).toContain('subagent_type: "codex-agents:codex"')
  expect(added?.text).toMatch(/\/scripts\/codex-agent limits/)
})
