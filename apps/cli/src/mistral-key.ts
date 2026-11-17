import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * First-run Mistral key intake. The base bundle defaults to the Mistral
 * provider, so a fresh checkout needs MISTRAL_API_KEY before the first profile
 * boot. Prompts on the terminal when the key is missing and persists it to
 * `$DSH_HOME/.env` (0600); non-interactive runs just print the remedy.
 */
export async function ensureMistralApiKey(): Promise<void> {
  if (process.env.MISTRAL_API_KEY !== undefined && process.env.MISTRAL_API_KEY !== '') return
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'dsh: MISTRAL_API_KEY is not set and the default provider is Mistral. '
      + 'Get a key at https://console.mistral.ai, then export MISTRAL_API_KEY or add it to ~/.dsh/.env\n',
    )
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const muted = rl as unknown as { _writeToOutput?: (s: string) => void }
  const original = muted._writeToOutput?.bind(rl)
  if (original !== undefined) muted._writeToOutput = (s: string) => original(s.replace(/[^\n]/g, '*'))
  const key = await new Promise<string>(resolve => {
    rl.question('Mistral API key (https://console.mistral.ai), empty to skip: ', resolve)
  }).then(answer => answer.trim())
  rl.close()
  if (key === '') {
    process.stderr.write('dsh: no key stored; set MISTRAL_API_KEY later or pick another provider in settings.\n')
    return
  }
  const envPath = `${resolveDshHome()}/.env`
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const line = `MISTRAL_API_KEY=${key}`
  const next = /^MISTRAL_API_KEY=.*$/m.test(existing)
    ? existing.replace(/^MISTRAL_API_KEY=.*$/m, line)
    : `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`
  writeFileSync(envPath, next, { mode: 0o600 })
  chmodSync(envPath, 0o600)
  process.env.MISTRAL_API_KEY = key
  process.stderr.write('dsh: stored MISTRAL_API_KEY in ~/.dsh/.env (0600)\n')
}
