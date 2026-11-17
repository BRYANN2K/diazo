import { describe, expect, it } from 'vitest'
import { lintDocKey } from '../shared/lintDocument'

/* A stored verdict stands for the document it scored: this HTML at this
   size, with computed styles, under today's rules. The key is what tells
   one document from another, not a timestamp, since a local save patches
   the HTML ahead of the server's updatedAt. */

const doc = { html: '<p>one</p>', width: 1440, height: 900 }

describe('lintDocKey', () => {
  it('is short and tells documents and sizes apart', () => {
    const key = lintDocKey({ ...doc, html: 'x'.repeat(200_000) })
    expect(key.length).toBeLessThan(40)
    expect(lintDocKey(doc)).toBe(lintDocKey({ ...doc }))
    expect(lintDocKey(doc)).not.toBe(lintDocKey({ ...doc, html: '<p>One</p>' }))
    expect(lintDocKey(doc)).not.toBe(lintDocKey({ ...doc, width: 1439 }))
  })
})
