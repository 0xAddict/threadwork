import { AGENT_SESSIONS, TMUX_PATH } from './config'

export function resolveSession(agent: string): string | null {
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

export function buildNudgeCommand(session: string, message: string): string[] {
  return [TMUX_PATH, 'send-keys', '-t', session, message, 'Enter']
}

// Test-mode guard: when running under `bun test`, Bun sets process.env.NODE_ENV = 'test'
// automatically. We also honor an explicit THREADWORK_NUDGE_DISABLE escape hatch for
// running scripts locally without spamming real agent sessions.
//
// Without this guard, tests that use isolated TEST_DBs would still fire real tmux
// send-keys at real claude-{agent} sessions via the side-effectful nudgeAgent,
// producing fixture-title spam in running agents' main threads.
const NUDGE_DISABLED =
  process.env.NODE_ENV === 'test' ||
  process.env.THREADWORK_NUDGE_DISABLE === '1' ||
  typeof (globalThis as any).Bun?.jest === 'function'

export async function nudgeAgent(
  agent: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = resolveSession(agent)
  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
  }

  if (NUDGE_DISABLED) {
    // No-op in test mode — tests that need to assert on nudges should check
    // the audit log or use dependency injection, not observe real tmux side effects.
    return { ok: true }
  }

  const cmd = buildNudgeCommand(session, message)
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, error: `tmux failed (exit ${exitCode}): ${stderr.trim()}` }
  }

  return { ok: true }
}
