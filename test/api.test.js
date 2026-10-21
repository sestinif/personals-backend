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

// Lancia uno script del backend e aspetta che finisca
async function runNode(script, env) {
  const child = spawn(process.execPath, [script], { cwd: root, env })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const timer = setTimeout(() => child.kill(), 5000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  return { code, log }
}

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
    env: { ...process.env, PORT: String(port), TURSO_DATABASE_URL: `file:${join(tmp, 'test.db')}`, TURSO_AUTH_TOKEN: '', JWT_SECRET: 'solo-per-i-test', ALLOW_REGISTRATION: 'true' },
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

test('PUT /expenses/:id senza renewal_day e end_date li lascia, con un valore vuoto li azzera', async () => {
  const account = await call('/accounts', { method: 'POST', body: { name: 'Conto Rate' } })
  const created = await call('/expenses', {
    method: 'POST',
    body: { account_id: account.json.id, name: 'MacBook', amount: 40.73, renewal_day: '27', expense_type: 'installment', end_date: '2027-03' },
  })
  assert.equal(created.status, 201)

  const kept = await call(`/expenses/${created.json.id}`, { method: 'PUT', body: { amount: 41 } })
  assert.equal(kept.status, 200, kept.text)
  assert.equal(kept.json.renewal_day, '27')
  assert.equal(kept.json.end_date, '2027-03')

  // il form manda '' quando il campo è vuoto
  const cleared = await call(`/expenses/${created.json.id}`, { method: 'PUT', body: { renewal_day: '', end_date: '' } })
  assert.equal(cleared.status, 200, cleared.text)
  assert.equal(cleared.json.renewal_day, null)
  assert.equal(cleared.json.end_date, null)
  assert.equal(cleared.json.amount, 41)
})

test('POST /accounts con un nome già usato torna 409 con un messaggio', async () => {
  const first = await call('/accounts', { method: 'POST', body: { name: 'Doppione' } })
  assert.equal(first.status, 201)

  const second = await call('/accounts', { method: 'POST', body: { name: 'Doppione' } })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.json.error, 'An account with this name already exists')

  // il nome è libero per un altro utente
  const other = await otherUser('altro-nome')
  const theirs = await call('/accounts', { method: 'POST', body: { name: 'Doppione' }, as: other })
  assert.equal(theirs.status, 201, theirs.text)
})

test('PUT /accounts/:id sul nome di un altro conto torna 409, sul proprio nome no', async () => {
  const a = await call('/accounts', { method: 'POST', body: { name: 'Primo' } })
  const b = await call('/accounts', { method: 'POST', body: { name: 'Secondo' } })

  const clash = await call(`/accounts/${b.json.id}`, { method: 'PUT', body: { name: 'Primo' } })
  assert.equal(clash.status, 409, clash.text)
  assert.equal(clash.json.error, 'An account with this name already exists')

  const same = await call(`/accounts/${a.json.id}`, { method: 'PUT', body: { name: 'Primo', icon: 'wallet' } })
  assert.equal(same.status, 200, same.text)
  assert.equal(same.json.icon, 'wallet')
})

test('un errore del database dentro una route torna 500 in JSON e il server resta su', async () => {
  // un oggetto non si può passare come valore: la query fallisce
  const account = await call('/accounts', { method: 'POST', body: { name: 'Conto Errore' } })
  const res = await call('/expenses', { method: 'POST', body: { account_id: account.json.id, name: { a: 1 }, amount: 1 } })
  assert.equal(res.status, 500, res.text)
  assert.equal(res.json.error, 'Internal server error')
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

test('GET /debug/expenses non esiste più', async () => {
  const res = await call('/debug/expenses')
  assert.equal(res.status, 404, res.text)
})

test('senza ALLOW_REGISTRATION la registrazione è chiusa, il login no, e il seed non crea utenti con una password nota', async () => {
  const port = await freePort()
  const env = { ...process.env, PORT: String(port), TURSO_DATABASE_URL: `file:${join(tmp, 'closed.db')}`, TURSO_AUTH_TOKEN: '', JWT_SECRET: 'solo-per-i-test' }
  delete env.ALLOW_REGISTRATION
  delete env.SEED_PASSWORD

  // Senza SEED_PASSWORD il seed non deve creare l'utente demo: se lo creasse,
  // il secondo giro lo troverebbe già lì e la password scelta non varrebbe.
  const skipped = await runNode('seed.js', env)
  assert.equal(skipped.code, 0, skipped.log)
  const seeded = await runNode('seed.js', { ...env, SEED_PASSWORD: 'scelta-da-me-1' })
  assert.equal(seeded.code, 0, seeded.log)
  assert.ok(!seeded.log.includes('scelta-da-me-1'), 'il seed stampa la password nel log')

  const closed = spawn(process.execPath, ['index.js'], { cwd: root, env })
  let log = ''
  closed.stdout.on('data', (d) => { log += d })
  closed.stderr.on('data', (d) => { log += d })
  try {
    for (let i = 0; i < 100 && !log.includes('Server running'); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(log.includes('Server running'), `il server non è partito:\n${log}`)
    const post = (path, body) => fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    const reg = await post('/auth/register', { username: 'sconosciuto', password: 'sconosciuto1' })
    assert.equal(reg.status, 403)
    const again = await post('/auth/login', { username: 'sconosciuto', password: 'sconosciuto1' })
    assert.equal(again.status, 401, 'la registrazione ha creato lo stesso l\'utente')

    const login = await post('/auth/login', { username: 'demo', password: 'scelta-da-me-1' })
    assert.equal(login.status, 200)
  } finally {
    closed.kill()
  }
})

test('i messaggi di errore del login e della registrazione sono in inglese', async () => {
  const empty = await call('/auth/login', { method: 'POST', body: {}, as: null })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'Username and password are required')

  const wrong = await call('/auth/login', { method: 'POST', body: { username: 'tester', password: 'sbagliata' }, as: null })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json.error, 'Invalid credentials')

  const short = await call('/auth/register', { method: 'POST', body: { username: 'ab', password: 'abcdef' }, as: null })
  assert.equal(short.status, 400)
  assert.equal(short.json.error, 'Username must be at least 3 characters')

  const taken = await call('/auth/register', { method: 'POST', body: { username: 'tester', password: 'abcdef' }, as: null })
  assert.equal(taken.status, 409)
  assert.equal(taken.json.error, 'Username already taken')
})

test('GET /withdrawals vuole il login, e senza Numbers collegato dice configured:false', async () => {
  const anon = await call('/withdrawals', { as: null })
  assert.equal(anon.status, 401)
  const res = await call('/withdrawals')
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json, { configured: false })
  const bad = await call('/withdrawals?month=boh')
  assert.equal(bad.status, 200, 'senza Numbers collegato non si guarda nemmeno il mese')
  assert.ok(alive(), `il server è caduto:\n${serverLog}`)
})
