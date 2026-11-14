// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { findPreviewRuntime, withFindPreviewScript } from '../src/lib/findPreviewRuntime'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('withFindPreviewScript', () => {
  it('appends the script inside the last </body>', () => {
    const html = withFindPreviewScript('<html><body><p>x</p></body></html>', 't')
    expect(html).toMatch(/<p>x<\/p><script data-doop-find>[\s\S]*\("t"\);<\/script><\/body><\/html>$/)
  })
  it('appends to a document without a body', () => {
    expect(withFindPreviewScript('<p>x</p>', 't')).toMatch(/^<p>x<\/p><script data-doop-find>/)
  })
})

describe('findPreviewRuntime', () => {
  it('outlines the focus, then moves the outline and restores the previous style', async () => {
    document.body.innerHTML =
      '<section><div id="a" style="color: red"><span>cp.one</span></div><div id="b"><span>cp.two</span></div></section>'
    const posted: { type: string; focus?: string }[] = []
    window.addEventListener('message', (e) => posted.push(e.data as { type: string }))
    findPreviewRuntime('t')
    const send = (focus: string) =>
      window.dispatchEvent(new MessageEvent('message', { data: { doopFindPreview: 't', focus }, source: window }))
    send('cp.one')
    await tick(10)
    const outlined = () => [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.outline).length
    expect(outlined()).toBe(1)
    send('cp.two')
    await tick(10)
    expect(outlined()).toBe(1)
    expect(document.getElementById('a')!.style.cssText).toMatch(/^color: red;?$/)
    expect(posted.filter((m) => m.type === 'box').map((m) => m.focus)).toEqual(['cp.one', 'cp.two'])
  })
})
