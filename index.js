import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import db, { initDb } from './db.js'

// No fallback: a secret written in the code lets anyone forge a token
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('JWT_SECRET is not set: refusing to start')
  process.exit(1)
}

await initDb()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Express 4 does not await async handlers: without this a rejected promise
// is an unhandled rejection and Node exits. Forward it to the error handler.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// libSQL throws on undefined args; null lets COALESCE keep the stored value
const orNull = (value) => value === undefined ? null : value

// === AUTH MIDDLEWARE ===

function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    req.userId = payload.userId
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// === AUTH ROUTES ===

app.post('/api/auth/register', route(async (req, res) => {
  // Closed unless explicitly opened: this is a personal app, not a public signup
  if (process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ error: 'Registration is closed' })

  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' })
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' })
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

  const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] })
  if (existing.rows.length) return res.status(409).json({ error: 'Username already taken' })

  const hash = bcrypt.hashSync(password, 10)
  const result = await db.execute({ sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', args: [username, hash] })
  const userId = result.rows[0].id
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' })
  res.status(201).json({ token, user: { id: userId, username } })
}))

app.post('/api/auth/login', route(async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' })

  const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })
  const user = result.rows[0]
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ token, user: { id: user.id, username: user.username } })
}))

app.get('/api/auth/me', authenticate, route(async (req, res) => {
  const result = await db.execute({ sql: 'SELECT id, username, created_at FROM users WHERE id = ?', args: [req.userId] })
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' })
  res.json(result.rows[0])
}))

// === ALL ROUTES BELOW REQUIRE AUTH ===

app.use('/api/accounts', authenticate)
app.use('/api/expenses', authenticate)
app.use('/api/dashboard', authenticate)

// === ACCOUNTS ===

app.get('/api/accounts', route(async (req, res) => {
  const result = await db.execute({ sql: 'SELECT * FROM accounts WHERE user_id = ? ORDER BY sort_order', args: [req.userId] })
  res.json(result.rows)
}))

app.post('/api/accounts', route(async (req, res) => {
  const { name, icon, color } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const taken = await db.execute({ sql: 'SELECT id FROM accounts WHERE user_id = ? AND name = ?', args: [req.userId, name] })
  if (taken.rows.length) return res.status(409).json({ error: 'An account with this name already exists' })
  const maxOrder = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) as max FROM accounts WHERE user_id = ?', args: [req.userId] })
  const result = await db.execute({
    sql: 'INSERT INTO accounts (user_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING *',
    args: [req.userId, name, icon || 'credit-card', color || '#6366f1', maxOrder.rows[0].max + 1]
  })
  res.status(201).json(result.rows[0])
}))

app.put('/api/accounts/:id', route(async (req, res) => {
  const { name, icon, color } = req.body
  if (name != null) {
    const taken = await db.execute({ sql: 'SELECT id FROM accounts WHERE user_id = ? AND name = ? AND id != ?', args: [req.userId, name, req.params.id] })
    if (taken.rows.length) return res.status(409).json({ error: 'An account with this name already exists' })
  }
  await db.execute({
    sql: 'UPDATE accounts SET name = COALESCE(?, name), icon = COALESCE(?, icon), color = COALESCE(?, color) WHERE id = ? AND user_id = ?',
    args: [orNull(name), orNull(icon), orNull(color), req.params.id, req.userId]
  })
  const result = await db.execute({ sql: 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] })
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' })
  res.json(result.rows[0])
}))

app.delete('/api/accounts/:id', route(async (req, res) => {
  // Delete expenses first (no CASCADE in libSQL), only if the account is the user's
  await db.execute({
    sql: 'DELETE FROM expenses WHERE account_id IN (SELECT id FROM accounts WHERE id = ? AND user_id = ?)',
    args: [req.params.id, req.userId]
  })
  const result = await db.execute({ sql: 'DELETE FROM accounts WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] })
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ success: true })
}))

// === EXPENSES ===

app.get('/api/expenses', route(async (req, res) => {
  const { account_id } = req.query
  if (account_id) {
    const acc = await db.execute({ sql: 'SELECT id FROM accounts WHERE id = ? AND user_id = ?', args: [account_id, req.userId] })
    if (!acc.rows.length) return res.json([])
    const result = await db.execute({ sql: 'SELECT * FROM expenses WHERE account_id = ? ORDER BY created_at', args: [account_id] })
    res.json(result.rows)
  } else {
    const result = await db.execute({
      sql: 'SELECT e.* FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ? ORDER BY e.account_id, e.created_at',
      args: [req.userId]
    })
    res.json(result.rows)
  }
}))

app.post('/api/expenses', route(async (req, res) => {
  const { account_id, name, amount, renewal_day, frequency, expense_type, end_date } = req.body
  if (!account_id || !name || amount == null) return res.status(400).json({ error: 'account_id, name, and amount are required' })

  const acc = await db.execute({ sql: 'SELECT id FROM accounts WHERE id = ? AND user_id = ?', args: [account_id, req.userId] })
  if (!acc.rows.length) return res.status(403).json({ error: 'Account not owned by user' })

  const result = await db.execute({
    sql: 'INSERT INTO expenses (account_id, name, amount, renewal_day, frequency, expense_type, end_date) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
    args: [account_id, name, amount, renewal_day || null, frequency || 'monthly', expense_type || 'subscription', end_date || null]
  })
  res.status(201).json(result.rows[0])
}))

app.put('/api/expenses/:id', route(async (req, res) => {
  const { name, amount, renewal_day, account_id, frequency, expense_type, end_date } = req.body
  const check = await db.execute({
    sql: 'SELECT e.id, e.renewal_day, e.end_date FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?',
    args: [req.params.id, req.userId]
  })
  if (!check.rows.length) return res.status(404).json({ error: 'Expense not found' })
  const current = check.rows[0]

  if (account_id != null) {
    const acc = await db.execute({ sql: 'SELECT id FROM accounts WHERE id = ? AND user_id = ?', args: [account_id, req.userId] })
    if (!acc.rows.length) return res.status(403).json({ error: 'Account not owned by user' })
  }

  // renewal_day and end_date can be cleared: a missing field keeps the stored value, an empty one clears it
  const nextRenewalDay = renewal_day === undefined ? current.renewal_day : renewal_day || null
  const nextEndDate = end_date === undefined ? current.end_date : end_date || null

  await db.execute({
    sql: 'UPDATE expenses SET name = COALESCE(?, name), amount = COALESCE(?, amount), renewal_day = ?, account_id = COALESCE(?, account_id), frequency = COALESCE(?, frequency), expense_type = COALESCE(?, expense_type), end_date = ? WHERE id = ?',
    args: [orNull(name), orNull(amount), nextRenewalDay, orNull(account_id), orNull(frequency), orNull(expense_type), nextEndDate, req.params.id]
  })
  const result = await db.execute({ sql: 'SELECT * FROM expenses WHERE id = ?', args: [req.params.id] })
  res.json(result.rows[0])
}))

app.delete('/api/expenses/:id', route(async (req, res) => {
  const check = await db.execute({
    sql: 'SELECT e.id FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?',
    args: [req.params.id, req.userId]
  })
  if (!check.rows.length) return res.status(404).json({ error: 'Expense not found' })

  await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [req.params.id] })
  res.json({ success: true })
}))

// === DASHBOARD ===

app.get('/api/dashboard', route(async (req, res) => {
  const accountsResult = await db.execute({
    sql: `SELECT a.*,
            COALESCE(SUM(CASE WHEN e.frequency = 'yearly' OR LOWER(TRIM(e.renewal_day)) LIKE '%annuale%' THEN e.amount / 12.0 ELSE e.amount END), 0) as total
          FROM accounts a LEFT JOIN expenses e ON e.account_id = a.id
          WHERE a.user_id = ? GROUP BY a.id ORDER BY a.sort_order`,
    args: [req.userId]
  })

  const accounts = accountsResult.rows
  const grandTotal = accounts.reduce((sum, a) => sum + Number(a.total), 0)

  const countResult = await db.execute({
    sql: 'SELECT COUNT(*) as count FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?',
    args: [req.userId]
  })

  res.json({ accounts, grandTotal, totalExpenses: Number(countResult.rows[0].count) })
}))

// === ERROR HANDLER ===

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  // body-parser errors (malformed JSON, payload too large) carry their own 4xx status
  const status = err.status >= 400 && err.status < 500 ? err.status : 500
  if (status === 500) console.error(`${req.method} ${req.originalUrl}`, err)
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
