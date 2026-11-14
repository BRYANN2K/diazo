import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
import type { LinkAccess } from '../shared/canvasRole'
import { libraryCanvas } from './libraryFixtures'

/* Who may read, curate and manage a library, for every kind of person,
   and that a library read never opens the canvas itself. */

const flags = vi.hoisted(() => ({ publicLibraries: false }))
vi.mock('../server/env.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/env.ts')>()
  return {
    ...mod,
    env: Object.defineProperty({ ...mod.env }, 'DOOP_PUBLIC_LIBRARIES', { get: () => flags.publicLibraries }),
  }
})
/* the workspace "ws": wsadmin is its admin, wsmember a member */
vi.mock('../server/workspaces.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/workspaces.ts')>()
  const roles: Record<string, 'admin' | 'member'> = { wsadmin: 'admin', wsmember: 'member' }
  return {
    ...mod,
    isWorkspaceMember: (ws: string, user: string | undefined) => ws === 'ws' && !!user && user in roles,
    hasRole: (ws: string, user: string | undefined, atLeast: string) =>
      ws === 'ws' && !!user && (roles[user] === 'admin' || atLeast === 'member') && user in roles,
  }
})
vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const { canAccessCanvas } = await import('../server/access.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }

function seed(link: LinkAccess = 'none', workspace = true): Canvas {
  const canvas = libraryCanvas([{ name: 'cp.a — A', html: '<p>a</p>' }], { id: 'lib1', ownerId: 'owner' })
  canvas.memberIds = ['invited']
  if (link !== 'none') canvas.linkAccess = link
  if (workspace) canvas.workspaceId = 'ws'
  store.init([canvas])
  libraries.resetLibrariesForTest()
  libraries.createLibrary('lib1', { preset: 'blank' }, actor)
  return store.getCanvas('lib1')!
}

beforeEach(() => {
  flags.publicLibraries = false
})

describe('the library gate', () => {
  it.each([
    ['owner', 'none', 'manage'],
    ['invited', 'none', 'curate'],
    ['wsmember', 'none', 'curate'],
    ['wsadmin', 'none', 'manage'],
    ['visitor', 'view', 'read'],
    ['visitor', 'comment', 'read'],
    ['visitor', 'edit', 'curate'],
    ['stranger', 'none', null],
  ] as const)('%s with a %s link is %s', (user, link, role) => {
    const canvas = seed(link)
    expect(libraries.libraryRole(user, canvas)).toBe(role)
  })

  it('takes workspace visibility only for a canvas in a workspace', () => {
    seed('none', false)
    const r = libraries.updateLibrary('lib1', { visibility: 'workspace' }, actor)
    expect(r.ok).toBe(false)
    seed('none', true)
    expect(libraries.updateLibrary('lib1', { visibility: 'workspace' }, actor).ok).toBe(true)
  })

  it('refuses public while the instance keeps libraries private', () => {
    seed()
    const r = libraries.updateLibrary('lib1', { visibility: 'public' }, actor)
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it('lets a stranger read a public library, never the canvas', () => {
    flags.publicLibraries = true
    const canvas = seed('none', false)
    expect(libraries.updateLibrary('lib1', { visibility: 'public' }, actor).ok).toBe(true)
    expect(libraries.libraryRole('stranger', canvas)).toBe('read')
    expect(canAccessCanvas('stranger', canvas)).toBe(false)
    /* the flag going off hides it at once: nothing is cached */
    flags.publicLibraries = false
    expect(libraries.libraryRole('stranger', canvas)).toBeNull()
  })

  it('never makes a workspace library open the canvas to a stranger', () => {
    const canvas = seed()
    libraries.updateLibrary('lib1', { visibility: 'workspace' }, actor)
    expect(libraries.libraryRole('stranger', canvas)).toBeNull()
    expect(canAccessCanvas('stranger', canvas)).toBe(false)
  })
})
