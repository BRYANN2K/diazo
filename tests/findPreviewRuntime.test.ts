// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
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

describe('the preview lets the item play', () => {
  it('adds nothing that stops animations or scripts', () => {
    const html = withFindPreviewScript(
      '<html><head><style>@keyframes spin{to{rotate:1turn}}.s{animation:spin 1s infinite}</style></head><body><div class="s"></div><script>window.demo=1</script></body></html>',
      't',
    )
    expect(html).toContain('<script>window.demo=1</script>')
    expect(html).toContain('animation:spin 1s infinite')
    for (const stop of ['animation-play-state', 'prefers-reduced-motion', 'animation: none', 'transition: none']) {
      expect(html).not.toContain(stop)
    }
  })

  it('pauses what runs on { play: false } and plays only that again on { play: true }', async () => {
    document.body.innerHTML = '<p>x</p>'
    const fake = (playState: string) => {
      const a = {
        playState,
        pause: vi.fn(() => (a.playState = 'paused')),
        play: vi.fn(() => (a.playState = 'running')),
      }
      return a
    }
    const running = fake('running')
    const mine = fake('paused')
    const original = document.getAnimations
    document.getAnimations = (() => [running, mine]) as unknown as typeof document.getAnimations
    try {
      findPreviewRuntime('p')
      const send = (play: boolean) =>
        window.dispatchEvent(new MessageEvent('message', { data: { doopFindPreview: 'p', play }, source: window }))
      send(false)
      await tick()
      expect(running.pause).toHaveBeenCalledTimes(1)
      expect(mine.pause).not.toHaveBeenCalled()
      send(true)
      await tick()
      expect(running.play).toHaveBeenCalledTimes(1)
      /* an animation the sheet paused itself stays paused */
      expect(mine.play).not.toHaveBeenCalled()
    } finally {
      document.getAnimations = original
    }
  })

  it('does not follow a link clicked in a demo, but lets the demo hear the click', () => {
    document.body.innerHTML = '<a id="out" href="/elsewhere">go</a><a id="in" href="#tab">tab</a>'
    findPreviewRuntime('l')
    const heard: string[] = []
    document.body.addEventListener('click', (e) => heard.push((e.target as HTMLElement).id))
    const click = (id: string) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true })
      document.getElementById(id)!.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(click('out')).toBe(true)
    expect(click('in')).toBe(false)
    expect(heard).toEqual(['out', 'in'])
  })
})
