import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import db, { initDb } from './db.js'

await initDb()

const app = express()
const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'personals-secret-change-in-production'

app.use(cors())
app.use(express.json())

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

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username e password sono obbligatori' })
  if (username.length < 3) return res.status(400).json({ error: 'Username deve avere almeno 3 caratteri' })
  if (password.length < 6) return res.status(400).json({ error: 'Password deve avere almeno 6 caratteri' })

  const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] })
  if (existing.rows.length) return res.status(409).json({ error: 'Username già in uso' })

  const hash = bcrypt.hashSync(password, 10)
  const result = await db.execute({ sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', args: [username, hash] })
  const userId = result.rows[0].id
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' })
  res.status(201).json({ token, user: { id: userId, username } })
})

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username e password sono obbligatori' })

  const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })
  const user = result.rows[0]
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenziali non valide' })
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ token, user: { id: user.id, username: user.username } })
})

app.get('/api/auth/me', authenticate, async (req, res) => {
  const result = await db.execute({ sql: 'SELECT id, username, created_at FROM users WHERE id = ?', args: [req.userId] })
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' })
  res.json(result.rows[0])
})

// === ALL ROUTES BELOW REQUIRE AUTH ===

app.use('/api/accounts', authenticate)
app.use('/api/expenses', authenticate)
app.use('/api/dashboard', authenticate)

// === ACCOUNTS ===

app.get('/api/accounts', async (req, res) => {
  const result = await db.execute({ sql: 'SELECT * FROM accounts WHERE user_id = ? ORDER BY sort_order', args: [req.userId] })
  res.json(result.rows)
})

app.post('/api/accounts', async (req, res) => {
  const { name, icon, color } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const maxOrder = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) as max FROM accounts WHERE user_id = ?', args: [req.userId] })
  const result = await db.execute({
    sql: 'INSERT INTO accounts (user_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING *',
    args: [req.userId, name, icon || 'credit-card', color || '#6366f1', maxOrder.rows[0].max + 1]
  })
  res.status(201).json(result.rows[0])
})

app.put('/api/accounts/:id', async (req, res) => {
  const { name, icon, color } = req.body
  await db.execute({
    sql: 'UPDATE accounts SET name = COALESCE(?, name), icon = COALESCE(?, icon), color = COALESCE(?, color) WHERE id = ? AND user_id = ?',
    args: [name, icon, color, req.params.id, req.userId]
  })
  const result = await db.execute({ sql: 'SELECT * FROM accounts WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] })
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' })
  res.json(result.rows[0])
})

app.delete('/api/accounts/:id', async (req, res) => {
  // Delete expenses first (no CASCADE in libSQL)
  await db.execute({ sql: 'DELETE FROM expenses WHERE account_id = ?', args: [req.params.id] })
  const result = await db.execute({ sql: 'DELETE FROM accounts WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] })
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ success: true })
})

// === EXPENSES ===

app.get('/api/expenses', async (req, res) => {
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
})

app.post('/api/expenses', async (req, res) => {
  const { account_id, name, amount, renewal_day } = req.body
  if (!account_id || !name || amount == null) return res.status(400).json({ error: 'account_id, name, and amount are required' })

  const acc = await db.execute({ sql: 'SELECT id FROM accounts WHERE id = ? AND user_id = ?', args: [account_id, req.userId] })
  if (!acc.rows.length) return res.status(403).json({ error: 'Account not owned by user' })

  const result = await db.execute({
    sql: 'INSERT INTO expenses (account_id, name, amount, renewal_day) VALUES (?, ?, ?, ?) RETURNING *',
    args: [account_id, name, amount, renewal_day || null]
  })
  res.status(201).json(result.rows[0])
})

app.put('/api/expenses/:id', async (req, res) => {
  const { name, amount, renewal_day, account_id } = req.body
  const check = await db.execute({
    sql: 'SELECT e.id FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?',
    args: [req.params.id, req.userId]
  })
  if (!check.rows.length) return res.status(404).json({ error: 'Expense not found' })

  await db.execute({
    sql: 'UPDATE expenses SET name = COALESCE(?, name), amount = COALESCE(?, amount), renewal_day = COALESCE(?, renewal_day), account_id = COALESCE(?, account_id) WHERE id = ?',
    args: [name, amount, renewal_day, account_id, req.params.id]
  })
  const result = await db.execute({ sql: 'SELECT * FROM expenses WHERE id = ?', args: [req.params.id] })
  res.json(result.rows[0])
})

app.delete('/api/expenses/:id', async (req, res) => {
  const check = await db.execute({
    sql: 'SELECT e.id FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?',
    args: [req.params.id, req.userId]
  })
  if (!check.rows.length) return res.status(404).json({ error: 'Expense not found' })

  await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [req.params.id] })
  res.json({ success: true })
})

// === DASHBOARD ===

app.get('/api/dashboard', async (req, res) => {
  const accountsResult = await db.execute({
    sql: `SELECT a.*, COALESCE(SUM(e.amount), 0) as total
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
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
