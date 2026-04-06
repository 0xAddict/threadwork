import { AGENT_SESSIONS, TMUX_PATH } from './config'

export function resolveSession(agent: string): string | null {
  const label = agent.toLowerCase()
  return AGENT_SESSIONS[label] ?? null
}

export function buildNudgeCommand(session: string, message: string): string[] {
  return [TMUX_PATH, 'send-keys', '-t', session, message, 'Enter']
}

export async function nudgeAgent(
  agent: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = resolveSession(agent)
  if (!session) {
    return { ok: false, error: `Unknown agent: ${agent}` }
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
