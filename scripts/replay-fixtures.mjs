// Synthetic wire fixtures for the offline replay tiers (docs/offline-replay-design.md).
// They follow the shapes in docs/protocol-notes.md and never hold a recorded
// conversation. Shared by the in-process tests and the headless replay run.

const encoder = new TextEncoder()

/** Server-sent events as one response body; `event` names are used by the responses channel. */
export function sse(frames, init = {}) {
  const body = frames.map(frame => {
    if (frame === '[DONE]') return 'data: [DONE]\n\n'
    const { event, data } = frame.data === undefined ? { event: undefined, data: frame } : frame
    return `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
  }).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

const completionChunk = (delta, finish = null, extra = {}) =>
  ({ id: 'replay', object: 'chat.completion.chunk', created: 1, model: 'replay', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })

/** A chat-completions reply: optional reasoning, text, then stop. */
export function completionsText(text, { usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } = {}) {
  return sse([
    completionChunk({ role: 'assistant', content: '' }),
    completionChunk({ content: text }),
    completionChunk({}, 'stop'),
    { id: 'replay', object: 'chat.completion.chunk', created: 1, model: 'replay', choices: [], usage },
    '[DONE]',
  ])
}

/** A chat-completions reply that asks the host to run one tool. */
export function completionsToolCall(name, args, id = 'call_replay') {
  return sse([
    completionChunk({ role: 'assistant', content: '' }),
    completionChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
    completionChunk({}, 'tool_calls'),
    '[DONE]',
  ])
}

/** A responses-channel reply with one text message. */
export function responsesText(text) {
  const item = { id: 'msg_replay', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = (status, output) => ({ id: 'resp_replay', object: 'response', created_at: 1, status, model: 'replay', output, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })
  let seq = 0
  const frame = (type, data) => ({ event: type, data: { type, sequence_number: seq++, ...data } })
  return sse([
    frame('response.created', { response: response('in_progress', []) }),
    frame('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }),
    frame('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    frame('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text }),
    frame('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text }),
    frame('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] }),
    frame('response.output_item.done', { output_index: 0, item }),
    frame('response.completed', { response: response('completed', [item]) }),
  ])
}

export const textReply = { 'openai-completions': completionsText, 'openai-responses': responsesText }

/** An upstream refusal: status, JSON error body, optional headers. */
export function refusal(status, error, headers = {}) {
  return Response.json({ error }, { status, headers })
}

/** A stream that stops in the middle of a frame, as a dropped connection does. */
export function truncatedStream(frames) {
  const first = frames.slice(0, -1).map(f => `data: ${JSON.stringify(f)}\n\n`).join('')
  const cut = `data: ${JSON.stringify(frames.at(-1)).slice(0, 20)}`
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(first + cut))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}


/** One entry of the official model list, in the shape the plugin's catalogue reads. */
export function officialModel(id, { context = 200_000, output = 32_000, price = 0, api = 'chat-completions', efforts = ['low', 'high'] } = {}) {
  return {
    id,
    object: 'model',
    created: 1,
    owned_by: 'opencode',
    name: id,
    type: 'chat',
    modalities: { input: ['text', 'image/png'], output: ['text'] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true, toggle: true, effort: efforts } },
    limit: { context, output },
    cost: { text: { input: { price }, output: { price } } },
    api: { [api]: { base_url: 'https://opencode.ai/inference/openai/v1' } },
  }
}

export const modelList = entries => ({ object: 'list', data: entries })

/** A chat-completions reply whose usage reports `promptTokens` of input. */
export const completionsTextWithUsage = (text, promptTokens) =>
  completionsText(text, { usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 } })
