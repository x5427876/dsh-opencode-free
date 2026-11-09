// A scripted stand-in for the Zen inference endpoint, handed to the provider
// as its `fetch` option. The wire fixtures live in scripts/replay-fixtures.mjs.
export * from '../../scripts/replay-fixtures.mjs'

/**
 * Answer requests from a queue, one step per request. A step is a Response, an
 * Error to throw, or a function of the parsed request. Every request is
 * recorded; running past the script fails the test instead of looping.
 */
export function scriptedUpstream(steps) {
  const queue = [...steps]
  const requests = []
  const fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const record = { url: String(url), headers: new Headers(init?.headers), body }
    requests.push(record)
    const step = queue.shift()
    if (step === undefined) throw new Error(`replay script exhausted at request ${requests.length}`)
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(record) : step
  }
  return { fetch, requests, remaining: () => queue.length }
}

/** Tool names in a request body, for either wire format. */
export const toolNames = body => (body?.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort()

/** Collect the text of a finished assistant message. */
export const textOf = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('')
