/** Thin executable/importable entry for the provider-private runner core. */

import { consumeRunnerSelection } from './runner-launch.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

/** Host runtimes that consume the first `--` after the entry as their own option terminator. */
const CONSUMES_ARGV_TERMINATOR = 'bun' in process.versions

/**
 * Restore the private delimiter a host runtime consumed before the runner saw it.
 * Bun treats the first `--` after the entry script as its own end-of-options
 * marker, so `bun runner.js -- <target>` reaches the runner as `<target>`; the
 * private protocol requires the delimiter, so a Bun-hosted runner gets it back.
 * @param argv - arguments this entry received after its own path.
 * @param consumedTerminator - whether the host runtime consumed the delimiter.
 * @returns private runner arguments beginning with the target delimiter.
 */
export function runnerArgv(
  argv: readonly string[],
  consumedTerminator: boolean = CONSUMES_ARGV_TERMINATOR,
): string[] {
  return consumedTerminator && argv[0] !== '--' ? ['--', ...argv] : [...argv]
}

/**
 * Run a selector already removed by a packaging bootstrap.
 * @param selection - private runner selector or Linux launch-request locator.
 * @param argv - runner arguments after the entry path, defaulting to this process's.
 */
export async function runSelectedSubprocessRunner(
  selection: string,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  try {
    await runSpawnRunner(selection, runnerArgv(argv))
  } catch (error) {
    await reportSpawnRunnerFailure(selection, error)
  }
}

if (import.meta.main) {
  const selection = consumeRunnerSelection()
  if (selection === undefined) {
    process.exitCode = 127
  } else {
    void runSelectedSubprocessRunner(selection)
  }
}
