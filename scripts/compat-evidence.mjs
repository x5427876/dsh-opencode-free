// Parse host-owned JSON only in memory; reports receive comparison booleans.
import { resolve } from 'node:path'

export function parseHeadlessOutput(stdout) {
  const calls = new Map()
  let final
  let terminal = false
  try {
    for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
      const event = JSON.parse(line)
      if (!event || typeof event.type !== 'string' || terminal) throw new Error()
      if (event.type === 'tool_call') {
        if (event.truncated || typeof event.callId !== 'string' || !event.callId || calls.has(event.callId) || typeof event.tool !== 'string' || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) throw new Error()
        calls.set(event.callId, { tool: event.tool, input: event.input })
      } else if (event.type === 'tool_result') {
        const call = calls.get(event.callId)
        if (event.truncated || !call || call.result !== undefined || !['completed', 'error'].includes(event.status) || typeof event.result !== 'string') throw new Error()
        Object.assign(call, { status: event.status, result: event.result })
      } else if (event.type === 'final') {
        if (event.truncated || typeof event.text !== 'string') throw new Error()
        final = event.text
        terminal = true
      } else if (event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind !== 'completed') throw new Error()
    }
    if (!terminal || [...calls.values()].some(call => call.result === undefined)) throw new Error()
    return { valid: true, text: final, calls: [...calls.values()] }
  } catch {
    return { valid: false, text: '', calls: [] }
  }
}

export function verifyToolEvidence(evidence, step, expected) {
  const contains = value => typeof value === 'string' && new RegExp(`(?:^|[^a-f0-9])${expected}(?=$|[^a-f0-9])`, 'i').test(value)
  const calls = evidence?.valid ? evidence.calls.filter(call => call.tool === step.tool) : []
  const argumentMatches = call => {
    const input = call.input
    if (step.tool === 'read') return typeof input.file_path === 'string' && resolve(step.cwd, input.file_path) === resolve(step.cwd, step.file)
    return typeof input.command === 'string' && input.command.trim() === step.command && (step.tool !== 'pwsh' || typeof input.description === 'string' && input.description.trim() !== '') && (input.workdir === undefined || typeof input.workdir === 'string' && resolve(step.cwd, input.workdir) === resolve(step.cwd)) && input.run_in_background !== true
  }
  const matched = calls.filter(argumentMatches)
  return {
    callMatched: calls.length > 0,
    argumentsMatched: matched.length > 0,
    resultMatched: matched.some(call => call.status === 'completed' && contains(call.result)),
    finalMatched: contains(evidence?.text),
  }
}
