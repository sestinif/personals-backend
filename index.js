import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { downloadDb, uploadDb } from './github-sync.js'

// Download DB from GitHub before loading it
await downloadDb()

const { default: db } = await import('./db.js')

const app = express()
const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'personals-secret-change-in-production'

app.use(cors())
app.use(express.json())

// Auto-sync DB to GitHub after any write operation
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const origJson = res.json.bind(res)
    res.json = (data) => {
      origJson(data)
      if (res.statusCode < 400) uploadDb()
    }
  }
  next()
})

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

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password sono obbligatori' })
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username deve avere almeno 3 caratteri' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password deve avere almeno 6 caratteri' })
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    return res.status(409).json({ error: 'Username già in uso' })
  }

  const hash = bcrypt.hashSync(password, 10)
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
  const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' })

  res.status(201).json({ token, user: { id: result.lastInsertRowid, username } })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password sono obbligatori' })
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenziali non valide' })
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ token, user: { id: user.id, username: user.username } })
})

app.get('/api/auth/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(user)
})

// === ALL ROUTES BELOW REQUIRE AUTH ===

app.use('/api/accounts', authenticate)
app.use('/api/expenses', authenticate)
app.use('/api/dashboard', authenticate)

// === ACCOUNTS ===

app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY sort_order').all(req.userId)
  res.json(accounts)
})

app.post('/api/accounts', (req, res) => {
  const { name, icon, color } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM accounts WHERE user_id = ?').get(req.userId)
  const result = db.prepare('INSERT INTO accounts (user_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(req.userId, name, icon || 'credit-card', color || '#6366f1', maxOrder.max + 1)
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(account)
})

app.put('/api/accounts/:id', (req, res) => {
  const { name, icon, color } = req.body
  db.prepare('UPDATE accounts SET name = COALESCE(?, name), icon = COALESCE(?, icon), color = COALESCE(?, color) WHERE id = ? AND user_id = ?')
    .run(name, icon, color, req.params.id, req.userId)
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.userId)
  if (!account) return res.status(404).json({ error: 'Account not found' })
  res.json(account)
})

app.delete('/api/accounts/:id', (req, res) => {
  const result = db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(req.params.id, req.userId)
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ success: true })
})

// === EXPENSES ===

app.get('/api/expenses', (req, res) => {
  const { account_id } = req.query
  if (account_id) {
    const account = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.userId)
    if (!account) return res.json([])
    res.json(db.prepare('SELECT * FROM expenses WHERE account_id = ? ORDER BY created_at').all(account_id))
  } else {
    res.json(db.prepare(`
      SELECT e.* FROM expenses e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = ?
      ORDER BY e.account_id, e.created_at
    `).all(req.userId))
  }
})

app.post('/api/expenses', (req, res) => {
  const { account_id, name, amount, renewal_day } = req.body
  if (!account_id || !name || amount == null) {
    return res.status(400).json({ error: 'account_id, name, and amount are required' })
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.userId)
  if (!account) return res.status(403).json({ error: 'Account not owned by user' })

  const result = db.prepare('INSERT INTO expenses (account_id, name, amount, renewal_day) VALUES (?, ?, ?, ?)')
    .run(account_id, name, amount, renewal_day || null)
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(expense)
})

app.put('/api/expenses/:id', (req, res) => {
  const { name, amount, renewal_day, account_id } = req.body
  const expense = db.prepare(`
    SELECT e.id FROM expenses e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, req.userId)
  if (!expense) return res.status(404).json({ error: 'Expense not found' })

  db.prepare('UPDATE expenses SET name = COALESCE(?, name), amount = COALESCE(?, amount), renewal_day = COALESCE(?, renewal_day), account_id = COALESCE(?, account_id) WHERE id = ?')
    .run(name, amount, renewal_day, account_id, req.params.id)
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id))
})

app.delete('/api/expenses/:id', (req, res) => {
  const expense = db.prepare(`
    SELECT e.id FROM expenses e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, req.userId)
  if (!expense) return res.status(404).json({ error: 'Expense not found' })

  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// === DASHBOARD ===

app.get('/api/dashboard', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*, COALESCE(SUM(e.amount), 0) as total
    FROM accounts a
    LEFT JOIN expenses e ON e.account_id = a.id
    WHERE a.user_id = ?
    GROUP BY a.id
    ORDER BY a.sort_order
  `).all(req.userId)

  const grandTotal = accounts.reduce((sum, a) => sum + a.total, 0)
  const totalExpenses = db.prepare(`
    SELECT COUNT(*) as count FROM expenses e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
  `).get(req.userId).count

  res.json({ accounts, grandTotal, totalExpenses })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
