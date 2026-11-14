import { describe, expect, it } from 'vitest'
import { EMPTY_QUERY, galleryQueryString, parseGalleryQuery, staleGuard } from '../src/lib/libraryQuery'

describe('the gallery view in the URL', () => {
  it('round-trips', () => {
    const view = { q: 'otp input', kind: 'cp', in: 'Inputs & forms/OTP', tag: 'dark', sort: 'used' as const }
    expect(parseGalleryQuery(galleryQueryString(view))).toEqual(view)
    expect(galleryQueryString(EMPTY_QUERY)).toBe('')
    expect(parseGalleryQuery('?sort=nonsense').sort).toBe('relevance')
    expect(galleryQueryString({ ...EMPTY_QUERY, q: 'x' }, { from: 'c1', frame: null })).toBe('?q=x&from=c1')
  })

  it('drops a response older than the newest request', () => {
    const guard = staleGuard()
    const first = guard.next()
    const second = guard.next()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})
