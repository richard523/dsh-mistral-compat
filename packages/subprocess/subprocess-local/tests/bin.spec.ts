import { describe, expect, it } from 'vitest'
import { runnerArgv } from '../src/bin.ts'

describe('runner entry argv', () => {
  it('restores the private delimiter a Bun host consumed', () => {
    expect(runnerArgv(['node', 'target.mjs', 'arg'], true)).toEqual(['--', 'node', 'target.mjs', 'arg'])
  })

  it('keeps an intact delimiter', () => {
    expect(runnerArgv(['--', 'node', 'target.mjs'], true)).toEqual(['--', 'node', 'target.mjs'])
  })

  it('leaves a Node or packaged launch untouched', () => {
    expect(runnerArgv(['node', 'target.mjs'], false)).toEqual(['node', 'target.mjs'])
    expect(runnerArgv(['--', 'node'], false)).toEqual(['--', 'node'])
  })
})
