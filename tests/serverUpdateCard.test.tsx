// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutCardView } from '../src/components/AboutCard'
import { ServerUpdateCard, ServerUpdateCardView } from '../src/components/ServerUpdateCard'
import { UpdateCard } from '../src/components/UpdateCard'
import { UPDATE_DISMISSED_KEY } from '../src/lib/updateStatus'
import type { InstallType, UpdateStatus } from '../shared/updateCheck'

/**
 * The server's "Update available" card and the About card's status line:
 * the copy and the command per install type, the commit list, and that a
 * dismissal holds for that build only.
 */

const session = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: session.user ? { user: session.user } : null }) },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LATEST = '2'.repeat(40)

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: 'behind',
    install: 'docker',
    repo: 'BRYANN2K/diazo',
    branch: 'main',
    running: '1'.repeat(40),
    latest: LATEST,
    source: 'image',
    behindBy: 5,
    aheadBy: 0,
    commits: ['feat: five', 'fix: four', 'docs: three', 'chore: two', 'feat: one'].map((title, i) => ({
      sha: String(i).padStart(40, 'a'),
      title,
      url: `https://github.com/BRYANN2K/diazo/commit/${i}`,
    })),
    compareUrl: `https://github.com/BRYANN2K/diazo/compare/x...${LATEST}`,
    checkedAt: '2026-11-15T10:00:00.000Z',
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  session.user = { id: 'u1' }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(node: React.ReactNode) {
  await act(async () => root.render(node))
}

describe('the update card', () => {
  it('names the new commits, links the compare page and says how to update', async () => {
    await render(<ServerUpdateCardView status={status()} onDismiss={() => {}} />)
    expect(container.textContent).toContain('Update available')
    expect(container.textContent).toContain('5 new commits on BRYANN2K/diazo main.')
    const titles = [...container.querySelectorAll('li')].map((li) => li.textContent)
    expect(titles).toEqual(['feat: five', 'fix: four', 'docs: three'])
    const link = container.querySelector<HTMLAnchorElement>('a[href*="/compare/"]')!
    expect(link.textContent).toBe('and 2 more · See changes')
    expect(link.target).toBe('_blank')
  })

  it.each<[InstallType, string, string]>([
    ['local', 'diazo-local update', 'Run it in Terminal'],
    ['docker', 'docker compose pull && docker compose up -d', 'docker compose up -d --build'],
    ['kubernetes', 'kubectl -n doop rollout restart deploy/doop', 'imagePullPolicy Always'],
    ['source', 'git pull && bun install && bun run build', 'restart the server'],
  ])('gives a %s install its own command', async (install, command, hint) => {
    await render(<ServerUpdateCardView status={status({ install })} onDismiss={() => {}} />)
    expect(container.querySelector('[data-slot="code-block"]')?.firstChild?.textContent).toBe(command)
    expect(container.textContent).toContain(hint)
  })

  it('says one commit in the singular', async () => {
    await render(
      <ServerUpdateCardView
        status={status({ behindBy: 1, commits: status().commits.slice(0, 1) })}
        onDismiss={() => {}}
      />,
    )
    expect(container.textContent).toContain('1 new commit on BRYANN2K/diazo main.')
    expect(container.querySelector('a[href*="/compare/"]')?.textContent).toBe('See changes')
  })

  it('shows what the server answers, and stays away once dismissed for that build', async () => {
    let answer: UpdateStatus = status()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(answer)))
    await render(<ServerUpdateCard />)
    expect(container.textContent).toContain('Update available')

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss until the next update"]')!.click(),
    )
    expect(container.textContent).toBe('')
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe(LATEST)

    /* a newer build brings it back */
    answer = status({ latest: '3'.repeat(40) })
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(<ServerUpdateCard />)
    expect(container.textContent).toContain('Update available')
  })

  it('shows nothing to someone the server does not answer, or when up to date', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    await render(<ServerUpdateCard />)
    expect(container.textContent).toBe('')

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(status({ state: 'current', behindBy: 0 }))))
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(<ServerUpdateCard />)
    expect(container.textContent).toBe('')
  })

  it('asks nothing while signed out', async () => {
    session.user = null
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await render(<ServerUpdateCard />)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('in the desktop app', () => {
  it('stacks above the shell own update card, each with its own offer', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    vi.stubGlobal('__DOOP_UPDATE_CARD__', true)
    vi.stubGlobal('__TAURI__', {
      core: { invoke: async () => null },
      event: {
        listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
          handlers.set(name, handler)
          return () => {}
        },
      },
    })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(status())))
    await render(<UpdateCard />)
    await act(async () => handlers.get('update-ready')?.({ payload: { version: '0.12.0', current: '0.11.0' } }))
    const cards = [...container.querySelectorAll('section')].map((s) => s.getAttribute('aria-labelledby'))
    expect(cards).toEqual(['server-update-title', 'update-card-title'])
    expect(container.textContent).toContain('5 new commits on BRYANN2K/diazo main.')
    expect(container.textContent).toContain('Diazo 0.12.0 is ready')
  })
})

describe('the About card', () => {
  const info = { version: '0.14.0', sha: '1'.repeat(40), date: '2026-11-15T10:00:00.000Z' }

  it('shows the version, a commit link and, for admins, where the build stands', async () => {
    await render(<AboutCardView info={info} status={status()} />)
    expect(container.textContent).toContain('0.14.0')
    expect(container.querySelector<HTMLAnchorElement>('a[href$="/commit/' + info.sha + '"]')?.textContent).toBe(
      '1111111',
    )
    expect(container.textContent).toContain('5 new commits on BRYANN2K/diazo main')
  })

  it('says why it does not know', async () => {
    await render(
      <AboutCardView
        info={{ ...info, sha: null, date: null }}
        status={status({ state: 'unknown', reason: 'rate-limited' })}
      />,
    )
    expect(container.textContent).toContain('Unknown (built without its commit)')
    expect(container.textContent).toContain('Development checkout')
    expect(container.textContent).toContain('GitHub rate limit reached')
  })

  it('has no status row for someone who may not see it', async () => {
    await render(<AboutCardView info={info} status={null} />)
    expect(container.textContent).not.toContain('Updates')
  })
})
