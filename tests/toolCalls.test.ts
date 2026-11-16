import { describe, expect, it } from 'vitest'
import { byteSize, imagePixelsOf, recordToolCall, toolCallDeps, toolCallTotals } from '../server/toolCalls.ts'
import type { ToolCallRecord } from '../shared/toolCalls.ts'

/* a real 2x1 PNG so the pixel counter reads its header */
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR42mNk+M9QzwAEAAoBAf5/tXNPAAAAAElFTkSuQmCC'

function call(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'c1',
    canvasId: 'cv1',
    source: 'mcp',
    tool: 'create_frame',
    actorName: 'a',
    actorKind: 'agent',
    ownerId: null,
    runId: null,
    inputBytes: 10,
    resultBytes: 20,
    imagePixels: 0,
    ms: 5,
    failed: false,
    at: 1,
    ...over,
  }
}

describe('byteSize', () => {
  it('measures JSON bytes, with 0 for undefined and unserializable values', () => {
    expect(byteSize({ a: 1 })).toBe('{"a":1}'.length)
    expect(byteSize(undefined)).toBe(0)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(byteSize(circular)).toBe(0)
  })
})

describe('imagePixelsOf', () => {
  it('sums the pixels of every image block in a tool result', () => {
    const result = {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: PNG_2x1, mimeType: 'image/png' },
        { type: 'image', data: PNG_2x1, mimeType: 'image/png' },
      ],
    }
    expect(imagePixelsOf(result)).toBe(4) // 2x1 each
  })

  it('ignores non-image content, bad base64 and missing content', () => {
    expect(imagePixelsOf({ content: [{ type: 'text', text: 'x' }] })).toBe(0)
    expect(imagePixelsOf(null)).toBe(0)
    expect(imagePixelsOf({})).toBe(0)
    /* an undecodable blob falls back to imageSize's default 512x512 — still
      context weight worth counting */
    expect(imagePixelsOf({ content: [{ type: 'image', data: '!!!' }] })).toBe(512 * 512)
  })
})

describe('toolCallTotals', () => {
  it('aggregates totals and breaks them down per tool', () => {
    const totals = toolCallTotals([
      call({ tool: 'create_frame', inputBytes: 10, resultBytes: 100, imagePixels: 5, ms: 2 }),
      call({ id: 'c2', tool: 'create_frame', resultBytes: 50, imagePixels: 3, ms: 1 }),
      call({ id: 'c3', tool: 'get_frame_screenshot', resultBytes: 900, imagePixels: 100, failed: true }),
    ])
    expect(totals.calls).toBe(3)
    expect(totals.inputBytes).toBe(30)
    expect(totals.resultBytes).toBe(1050)
    expect(totals.imagePixels).toBe(108)
    expect(totals.failed).toBe(1)
    expect(totals.byTool.create_frame).toEqual({ calls: 2, resultBytes: 150, imagePixels: 8 })
    expect(totals.byTool.get_frame_screenshot.calls).toBe(1)
  })
})

describe('recordToolCall', () => {
  it('inserts one ledger row and never throws on a failing insert', async () => {
    const rows: unknown[] = []
    const insert = toolCallDeps.insert
    toolCallDeps.insert = async (row) => {
      rows.push(row)
    }
    try {
      recordToolCall(call({ at: 123 }) as Omit<ToolCallRecord, 'id'>)
      await Promise.resolve()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tool: 'create_frame', canvasId: 'cv1', at: 123 })

      toolCallDeps.insert = () => Promise.reject(new Error('db down'))
      recordToolCall(call() as Omit<ToolCallRecord, 'id'>) // fire-and-forget
      await new Promise((r) => setTimeout(r, 0))
    } finally {
      toolCallDeps.insert = insert
    }
  })
})
