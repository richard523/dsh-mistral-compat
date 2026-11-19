/** An OpenAI-compatible route survives Mistral-style `content` chunks. */

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

// Mistral's OpenAI-compatible endpoint streams `delta.content` as content
// chunks instead of a string for its reasoning models (GLM, Large 4). Joining
// those chunks as if they were text stringifies them ("[object Object]") and
// hands the harness a non-string text delta, which fails the turn.
const chunkedContentEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"weigh it"}],"closed":true}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"index":0,"content":[{"type":"text","text":"hello"}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"index":0,"content":[{"type":"text","text":" world"}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

async function mistralV1(url: string): Promise<Context> {
  vi.stubEnv('MISTRAL_V1_KEY', 'mistral-key')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { 'mistral-v1': {
    apiKeyEnv: 'MISTRAL_V1_KEY',
    api: 'openai-completions',
    baseURL: `${url}/v1`,
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: [{ id: 'zai-glm-5-3' }],
  } } })
  return ctx
}

it('reads Mistral content chunks as text and thinking instead of stringifying them', async () => {
  const server = await mockServer([{ events: chunkedContentEvents }])
  const ctx = await mistralV1(server.url)

  const result = await assemble(ctx, {
    provider: 'mistral-v1',
    model: 'zai-glm-5-3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })

  expect(result.finish).toEqual({ kind: 'stop' })
  expect(result.message.content).toEqual([
    { type: 'reasoning', text: 'weigh it' },
    { type: 'text', text: 'hello world' },
  ])
  expect(server.paths).toEqual(['/v1/chat/completions'])
})
