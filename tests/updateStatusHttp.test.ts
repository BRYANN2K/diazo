import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* GET /api/version is public; GET /api/update-status answers instance
   admins only (a 404 for everyone else, like /api/admin). The check itself
   is off here, so nothing asks GitHub. */

const SHA = 'c'.repeat(40)
let server: Server
let admin: Client
let member: Client

beforeAll(async () => {
  server = await startServer({
    ADMIN_EMAILS: 'updates-admin@test.dev',
    DOOP_BUILD_SHA: SHA,
    DOOP_BUILD_DATE: '2026-11-15T10:00:00Z',
    DOOP_UPDATE_CHECK: 'false',
    DOOP_INSTALL: 'docker',
  })
  admin = await new Client(server).signUp('updates-admin@test.dev', 'Updates Admin')
  member = await new Client(server).signUp('updates-member@test.dev', 'Updates Member')
}, 60_000)

afterAll(() => server?.stop())

it('tells anyone which build runs, without a session', async () => {
  const res = await fetch(`${server.base}/api/version`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ version: expect.any(String), sha: SHA, date: '2026-11-15T10:00:00.000Z' })
})

it('answers the update status to admins only', async () => {
  const res = await admin.get('/api/update-status')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ state: 'disabled', install: 'docker', running: SHA })

  expect((await member.get('/api/update-status')).status).toBe(404)
  expect((await fetch(`${server.base}/api/update-status`)).status).toBe(401)
})
