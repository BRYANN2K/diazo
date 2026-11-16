import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types'
import { fixtureUrl } from './browser'

declare global {
  interface Window {
    canvasPageHarness: { seed: (frames: Frame[]) => void; frames: () => Frame[] }
  }
}

/** A frame on canvas `c`, the one the fixture opens. */
export function canvasFrame(frame: Pick<Frame, 'id' | 'name' | 'x' | 'y' | 'width' | 'height'>): Frame {
  return { canvasId: 'c', html: '<body></body>', createdAt: 0, updatedAt: 0, updatedBy: 'Tester', ...frame }
}

/**
 * Open the real canvas page on `frames` with no backend behind it, for tests
 * whose subject is what the browser does with the page: the room's socket
 * never opens, the session is a signed-in person, and every other API call is
 * answered with an empty object. `search` is the page URL's query, as a deep
 * link carries it.
 */
export async function openCanvasPage(page: Page, frames: Frame[], search = ''): Promise<void> {
  await prepareCanvasPage(page)
  await showCanvasPage(page, frames, search)
}

/** An answer to a request outside `/api/`, or undefined to let it through.
 *  May be a promise: a test that holds a response back while it asserts what
 *  the page does without it resolves the promise to answer (or pass on) the
 *  request. */
export type FixtureResponse =
  { status: number; contentType?: string; body: Buffer | string; headers?: Record<string, string> } | undefined
export type FixtureResponder = (path: string) => FixtureResponse | Promise<FixtureResponse>

/** The stubs alone, for a test that has something to do before the page
 *  loads. `respond` answers other paths the test serves itself (frame images). */
export async function prepareCanvasPage(page: Page, respond?: FixtureResponder): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'WebSocket', {
      value: class {
        readyState = 0
        static OPEN = 1
        close() {}
      },
    })
  })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    const path = url.pathname
    if (!path.startsWith('/api/')) {
      void Promise.resolve(respond?.(path + url.search)).then((answer) =>
        answer ? request.respond(answer) : request.continue(),
      )
      return
    }
    const body =
      path === '/api/auth/get-session'
        ? { user: { id: 'u', name: 'Tester', email: 'tester@test.dev' }, session: { id: 's', userId: 'u' } }
        : path === '/api/canvases/c/fonts'
          ? []
          : {}
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

/** Load the fixture, or load it again, on a prepared page. */
export async function showCanvasPage(page: Page, frames: Frame[], search = ''): Promise<void> {
  await page.goto(fixtureUrl(`canvasPage.html${search}`))
  await page.waitForFunction(() => !!window.canvasPageHarness && !!document.querySelector('.stage'))
  await page.evaluate((frames) => window.canvasPageHarness.seed(frames), frames)
  await page.waitForSelector('[data-frame-title]')
}
