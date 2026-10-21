// Withdrawals: how much left the business Wise account for personal use this month.
// The numbers live in Numbers (it sees the transfers); this file only asks for them.
// Numbers answers on a read-only endpoint guarded by a key of its own (NUMBERS_EXPORT_KEY).

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const TIMEOUT_MS = 45000 // the first call can make Numbers read the whole Wise statement

export function isMonth(value) {
  return typeof value === 'string' && MONTH.test(value)
}

export function isConfigured(env) {
  return Boolean(env.NUMBERS_API_URL && env.NUMBERS_EXPORT_KEY)
}

// Never answers 401/403: the app logs the user out on those.
export async function loadWithdrawals({ env, month, fetchImpl = fetch }) {
  if (!isConfigured(env)) return { status: 200, body: { configured: false } }
  if (month !== undefined && !isMonth(month)) return { status: 400, body: { error: 'Month must look like 2026-11' } }

  const url = new URL('/api/export/withdrawals', env.NUMBERS_API_URL)
  if (month) url.searchParams.set('month', month)

  let res
  try {
    res = await fetchImpl(url, {
      headers: { 'x-api-key': env.NUMBERS_EXPORT_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { status: 502, body: { error: 'Numbers did not answer. Try again in a minute.' } }
  }

  let data = null
  try { data = await res.json() } catch { /* not JSON */ }
  if (!res.ok || !data) {
    const reason = res.status === 404 ? 'Numbers does not have withdrawals switched on yet.' : 'Numbers could not give the withdrawals.'
    return { status: 502, body: { error: reason } }
  }
  return { status: 200, body: { configured: true, ...data } }
}
