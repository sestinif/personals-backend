import bcrypt from 'bcryptjs'
import db from './db.js'

db.exec('DELETE FROM expenses; DELETE FROM accounts; DELETE FROM users;')

const insertAccount = db.prepare('INSERT INTO accounts (user_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)')
const insertExpense = db.prepare('INSERT INTO expenses (account_id, name, amount, renewal_day) VALUES (?, ?, ?, ?)')

const seed = db.transaction(() => {
  // Demo user (username: demo, password: demo123)
  const hash = bcrypt.hashSync('demo123', 10)
  const user = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('demo', hash)
  const uid = user.lastInsertRowid

  const a1 = insertAccount.run(uid, 'Intesa San Paolo', 'building', '#0066cc', 1)
  const a2 = insertAccount.run(uid, 'American Express', 'credit-card', '#006fcf', 2)
  const a3 = insertAccount.run(uid, 'Revolut Personal', 'wallet', '#8b5cf6', 3)
  const a4 = insertAccount.run(uid, 'Revolut Business', 'briefcase', '#0d9488', 4)

  insertExpense.run(a1.lastInsertRowid, 'Abb. Vodafone', 14.99, '11')
  insertExpense.run(a1.lastInsertRowid, 'iPhone 16 Pro (Emily)', 42.50, '5')
  insertExpense.run(a1.lastInsertRowid, 'MacBook Air 15\'', 40.73, '27')

  insertExpense.run(a2.lastInsertRowid, 'Spotify', 11.99, '1')
  insertExpense.run(a2.lastInsertRowid, 'Apple iCloud', 2.99, '16')
  insertExpense.run(a2.lastInsertRowid, 'Apple iCloud (Mamma)', 2.99, '10')
  insertExpense.run(a2.lastInsertRowid, 'Google Storage 200GB', 2.99, '14')
  insertExpense.run(a2.lastInsertRowid, 'NordPass', 1.89, 'annuale')
  insertExpense.run(a2.lastInsertRowid, 'Google Business (LLC)', 7.02, '14')
  insertExpense.run(a2.lastInsertRowid, 'Dominio (LLC)', 0.75, 'annuale')
  insertExpense.run(a2.lastInsertRowid, 'Render', 20.00, '14')

  insertExpense.run(a3.lastInsertRowid, 'Affitto', 1000.00, '15')
  insertExpense.run(a3.lastInsertRowid, 'Bollette + Internet', 125.00, '15')
  insertExpense.run(a3.lastInsertRowid, 'Assistente Personale', 350.00, '5')
  insertExpense.run(a3.lastInsertRowid, 'Claude', 89.00, '30')

  insertExpense.run(a4.lastInsertRowid, 'Conto corrente', 9.00, '5')
})

seed()
console.log('Database seeded! Demo user: demo / demo123')
