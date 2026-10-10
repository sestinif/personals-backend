// Avvia il server vero su un db usa e getta e controlla che un errore dentro
// una route torni come risposta HTTP, senza far cadere il processo.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let server, base, token, tmp
let serverLog = ''

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

const alive = () => server.exitCode === null && server.signalCode === null

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'personals-test-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}/api`
  server = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TURSO_DATABASE_URL: `file:${join(tmp, 'test.db')}`, TURSO_AUTH_TOKEN: '' },
  })
  server.stdout.on('data', (d) => { serverLog += d })
  server.stderr.on('data', (d) => { serverLog += d })

  for (let i = 0; i < 100 && !serverLog.includes('Server running'); i++) {
    if (!alive()) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(alive() && serverLog.includes('Server running'), `il server non è partito:\n${serverLog}`)

  const reg = await call('/auth/register', { method: 'POST', body: { username: 'tester', password: 'tester123' } })
  assert.equal(reg.status, 201)
  token = reg.json.token
})

after(() => {
  server?.kill()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

test('PUT /accounts/:id col solo name aggiorna il nome e lascia icona e colore', async () => {
  const created = await call('/accounts', { method: 'POST', body: { name: 'Conto A', icon: 'wallet', color: '#112233' } })
  assert.equal(created.status, 201)

  const res = await call(`/accounts/${created.json.id}`, { method: 'PUT', body: { name: 'Conto A2' } })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.name, 'Conto A2')
  assert.equal(res.json.icon, 'wallet')
  assert.equal(res.json.color, '#112233')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)
})

test('PUT /accounts/:id col corpo vuoto non cambia niente', async () => {
  const created = await call('/accounts', { method: 'POST', body: { name: 'Conto B', icon: 'building', color: '#445566' } })

  const res = await call(`/accounts/${created.json.id}`, { method: 'PUT', body: {} })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.name, 'Conto B')
  assert.equal(res.json.icon, 'building')
  assert.equal(res.json.color, '#445566')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)
})

test('PUT /expenses/:id col solo amount lascia nome, conto, frequenza e tipo', async () => {
  const account = await call('/accounts', { method: 'POST', body: { name: 'Conto C' } })
  const created = await call('/expenses', {
    method: 'POST',
    body: { account_id: account.json.id, name: 'Spotify', amount: 11.99, frequency: 'yearly', expense_type: 'installment' },
  })
  assert.equal(created.status, 201)

  const res = await call(`/expenses/${created.json.id}`, { method: 'PUT', body: { amount: 12.99 } })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.amount, 12.99)
  assert.equal(res.json.name, 'Spotify')
  assert.equal(res.json.account_id, account.json.id)
  assert.equal(res.json.frequency, 'yearly')
  assert.equal(res.json.expense_type, 'installment')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)
})

test('un errore del database dentro una route torna 500 in JSON e il server resta su', async () => {
  // UNIQUE(user_id, name): il secondo inserimento fa fallire la query
  const first = await call('/accounts', { method: 'POST', body: { name: 'Doppione' } })
  assert.equal(first.status, 201)

  const second = await call('/accounts', { method: 'POST', body: { name: 'Doppione' } })
  assert.equal(second.status, 500, second.text)
  assert.equal(typeof second.json?.error, 'string')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)

  const next = await call('/accounts')
  assert.equal(next.status, 200)
})

test('un JSON malformato torna 400 in JSON', async () => {
  const res = await fetch(`${base}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{"name": ',
  })
  assert.equal(res.status, 400)
  assert.equal(typeof (await res.json()).error, 'string')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)
})
