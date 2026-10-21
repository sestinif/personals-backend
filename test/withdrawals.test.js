import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWithdrawals, isConfigured, isMonth } from '../withdrawals.js'

const ENV = { NUMBERS_API_URL: 'https://numbers.example.com', NUMBERS_EXPORT_KEY: 'chiave-di-prova-lunga-abbastanza' }
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('senza le due variabili su Render la pagina riceve configured:false, senza chiamare nessuno', async () => {
  let called = false
  const r = await loadWithdrawals({ env: {}, fetchImpl: async () => { called = true } })
  assert.deepEqual(r, { status: 200, body: { configured: false } })
  assert.equal(called, false)
  assert.equal(isConfigured({ NUMBERS_API_URL: 'x' }), false)
  assert.equal(isConfigured(ENV), true)
})

test('chiede a Numbers il mese giusto, con la chiave nell\'header e non nell\'indirizzo', async () => {
  let seen
  const r = await loadWithdrawals({
    env: ENV, month: '2026-11',
    fetchImpl: async (url, opts) => { seen = { url: String(url), headers: opts.headers }; return { ok: true, status: 200, json: async () => ({ month: '2026-11', total_eur: 500, items: [] }) } },
  })
  assert.equal(seen.url, 'https://numbers.example.com/api/export/withdrawals?month=2026-11')
  assert.equal(seen.headers['x-api-key'], ENV.NUMBERS_EXPORT_KEY)
  assert.ok(!seen.url.includes(ENV.NUMBERS_EXPORT_KEY))
  assert.equal(r.status, 200)
  assert.equal(r.body.configured, true)
  assert.equal(r.body.total_eur, 500)
})

test('senza mese lascia scegliere a Numbers (il mese corrente)', async () => {
  let url
  await loadWithdrawals({ env: ENV, fetchImpl: async (u) => { url = String(u); return { ok: true, status: 200, json: async () => ({}) } } })
  assert.equal(url, 'https://numbers.example.com/api/export/withdrawals')
})

test('un mese scritto male non arriva a Numbers', async () => {
  let called = false
  for (const month of ['2026-13', '2026-1', 'novembre', '2026-11-01', '']) {
    const r = await loadWithdrawals({ env: ENV, month, fetchImpl: async () => { called = true } })
    assert.equal(r.status, 400, month)
  }
  assert.equal(called, false)
  assert.equal(isMonth('2026-11'), true)
})

test('se Numbers non risponde o dice no, la pagina riceve 502 e mai 401/403 (che la farebbero uscire)', async () => {
  const down = await loadWithdrawals({ env: ENV, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.status, 502)
  for (const code of [400, 401, 403, 404, 500]) {
    const r = await loadWithdrawals({ env: ENV, fetchImpl: reply(code, { error: 'x' }) })
    assert.equal(r.status, 502, String(code))
    assert.ok(r.body.error)
  }
  assert.match((await loadWithdrawals({ env: ENV, fetchImpl: reply(404, {}) })).body.error, /switched on/)
})
