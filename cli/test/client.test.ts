import { describe, expect, it } from 'vitest'
import { callTool, DoopError, type FetchLike } from '../src/client.ts'
import { openCommand } from '../src/io.ts'
import { fakeServer, KEY } from './helpers.ts'

const URL_ = 'https://doop.tailnet.test:8850'

describe('callTool', () => {
  it('posts one stateless tools/call to /mcp with the key as a bearer header', async () => {
    const server = fakeServer({ list_canvases: () => [{ id: 'c1', name: 'One' }] })
    const result = await callTool({ url: URL_, key: KEY, fetch: server.fetch }, 'list_canvases', {})
    expect(result).toEqual([{ id: 'c1', name: 'One' }])
    expect(server.calls).toEqual([
      { url: `${URL_}/mcp`, name: 'list_canvases', args: {}, authorization: `Bearer ${KEY}` },
    ])
  })

  it('returns prose results as text', async () => {
    const fetch: FetchLike = async () => Response.json({ result: { content: [{ type: 'text', text: 'plain words' }] } })
    expect(await callTool({ url: URL_, key: KEY, fetch }, 't', {})).toBe('plain words')
  })

  it('turns a tool error into a DoopError without the Error: prefix', async () => {
    const fetch: FetchLike = async () =>
      Response.json({ result: { isError: true, content: [{ type: 'text', text: 'Error: no frame f1' }] } })
    await expect(callTool({ url: URL_, key: KEY, fetch }, 'get_frame', {})).rejects.toThrow(/^no frame f1$/)
  })

  it('explains a refused key and never echoes it', async () => {
    const fetch: FetchLike = async () => Response.json({ error: { message: 'Unauthorized' } }, { status: 401 })
    const error = await callTool({ url: URL_, key: KEY, fetch }, 't', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DoopError)
    expect(String(error)).toMatch(/refused the agent key/)
    expect(String(error)).not.toContain(KEY)
  })

  it('reports an unreachable server without the key', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error(`connect failed with Bearer ${KEY}`))
    const error = await callTool({ url: URL_, key: KEY, fetch }, 't', {}).catch((e: unknown) => e)
    expect(String(error)).toMatch(/cannot reach https:\/\/doop\.tailnet\.test:8850/)
    expect(String(error)).not.toContain(KEY)
  })

  it('reports a non-JSON answer', async () => {
    const fetch: FetchLike = async () => new Response('<html>', { status: 502 })
    await expect(callTool({ url: URL_, key: KEY, fetch }, 't', {})).rejects.toThrow(/502 without JSON/)
  })

  it('reports a JSON-RPC error', async () => {
    const fetch: FetchLike = async () => Response.json({ error: { message: 'Method not found' } })
    await expect(callTool({ url: URL_, key: KEY, fetch }, 't', {})).rejects.toThrow('Method not found')
  })
})

describe('openCommand', () => {
  it('uses the platform opener without a shell', () => {
    expect(openCommand('darwin', 'https://x/c/1')).toEqual(['open', ['https://x/c/1']])
    expect(openCommand('linux', 'https://x/c/1')).toEqual(['xdg-open', ['https://x/c/1']])
    expect(openCommand('win32', 'https://x/c/1')[0]).toBe('rundll32')
  })
})
