// Avvia il server vero su un db usa e getta e controlla che un errore dentro
// una route torni come risposta HTTP, senza far cadere il processo.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
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

async function call(path, { method = 'GET', body, as = token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

const alive = () => server.exitCode === null && server.signalCode === null

// Un secondo utente, per controllare che non tocchi i dati del primo
async function otherUser(username) {
  const reg = await call('/auth/register', { method: 'POST', body: { username, password: 'intruso123' } })
  assert.equal(reg.status, 201, reg.text)
  return reg.json.token
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'personals-test-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}/api`
  server = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TURSO_DATABASE_URL: `file:${join(tmp, 'test.db')}`, TURSO_AUTH_TOKEN: '', JWT_SECRET: 'solo-per-i-test' },
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

test('DELETE /accounts/:id sul conto di un altro utente torna 404 e non gli cancella le spese', async () => {
  const account = await call('/accounts', { method: 'POST', body: { name: 'Conto della vittima' } })
  const expense = await call('/expenses', { method: 'POST', body: { account_id: account.json.id, name: 'Affitto', amount: 900 } })
  assert.equal(expense.status, 201)

  const intruder = await otherUser('intruso-delete')
  const res = await call(`/accounts/${account.json.id}`, { method: 'DELETE', as: intruder })
  assert.equal(res.status, 404, res.text)

  const left = await call(`/expenses?account_id=${account.json.id}`)
  assert.deepEqual(left.json.map((e) => e.name), ['Affitto'])
})

test('DELETE /accounts/:id sul proprio conto cancella il conto e le sue spese', async () => {
  const account = await call('/accounts', { method: 'POST', body: { name: 'Conto da chiudere' } })
  await call('/expenses', { method: 'POST', body: { account_id: account.json.id, name: 'Palestra', amount: 40 } })

  const res = await call(`/accounts/${account.json.id}`, { method: 'DELETE' })
  assert.equal(res.status, 200, res.text)

  const all = await call('/expenses')
  assert.ok(!all.json.some((e) => e.account_id === account.json.id), 'sono rimaste spese orfane')
  const accounts = await call('/accounts')
  assert.ok(!accounts.json.some((a) => a.id === account.json.id))
})

test('PUT /expenses/:id non sposta la spesa sul conto di un altro utente', async () => {
  const victimAccount = await call('/accounts', { method: 'POST', body: { name: 'Conto bersaglio' } })

  const intruder = await otherUser('intruso-put')
  const ownAccount = await call('/accounts', { method: 'POST', body: { name: 'Conto mio' }, as: intruder })
  const expense = await call('/expenses', { method: 'POST', body: { account_id: ownAccount.json.id, name: 'Intrusa', amount: 5 }, as: intruder })
  assert.equal(expense.status, 201)

  const res = await call(`/expenses/${expense.json.id}`, { method: 'PUT', body: { account_id: victimAccount.json.id }, as: intruder })
  assert.equal(res.status, 403, res.text)

  const victimExpenses = await call(`/expenses?account_id=${victimAccount.json.id}`)
  assert.deepEqual(victimExpenses.json, [])
  const own = await call(`/expenses?account_id=${ownAccount.json.id}`, { as: intruder })
  assert.deepEqual(own.json.map((e) => e.name), ['Intrusa'])
})

test('PUT /expenses/:id sposta la spesa su un altro conto dello stesso utente', async () => {
  const from = await call('/accounts', { method: 'POST', body: { name: 'Conto di partenza' } })
  const to = await call('/accounts', { method: 'POST', body: { name: 'Conto di arrivo' } })
  const expense = await call('/expenses', { method: 'POST', body: { account_id: from.json.id, name: 'Netflix', amount: 13 } })

  const res = await call(`/expenses/${expense.json.id}`, { method: 'PUT', body: { account_id: to.json.id } })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.account_id, to.json.id)
})

test('senza JWT_SECRET il server non parte', async () => {
  const env = { ...process.env, PORT: String(await freePort()), TURSO_DATABASE_URL: `file:${join(tmp, 'no-secret.db')}`, TURSO_AUTH_TOKEN: '' }
  delete env.JWT_SECRET
  const child = spawn(process.execPath, ['index.js'], { cwd: root, env })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const timer = setTimeout(() => child.kill(), 3000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)

  assert.equal(code, 1, `il server è partito lo stesso:\n${log}`)
  assert.match(log, /JWT_SECRET/)
})
