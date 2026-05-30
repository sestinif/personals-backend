import bcrypt from 'bcryptjs'
import db, { initDb } from './db.js'

await initDb()

const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: ['demo'] })
if (existing.rows.length) {
  console.log('Demo user already exists, skipping seed')
  process.exit(0)
}

const hash = bcrypt.hashSync('demo123', 10)
const user = await db.execute({ sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', args: ['demo', hash] })
const uid = user.rows[0].id

const ins = async (name, icon, color, order) => {
  const r = await db.execute({ sql: 'INSERT INTO accounts (user_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING id', args: [uid, name, icon, color, order] })
  return r.rows[0].id
}
const a1 = await ins('Intesa San Paolo', 'building', '#0066cc', 1)
const a2 = await ins('American Express', 'credit-card', '#006fcf', 2)
const a3 = await ins('Revolut Personal', 'wallet', '#8b5cf6', 3)
const a4 = await ins('Revolut Business', 'briefcase', '#0d9488', 4)

const exp = async (aid, name, amount, day) => {
  await db.execute({ sql: 'INSERT INTO expenses (account_id, name, amount, renewal_day) VALUES (?, ?, ?, ?)', args: [aid, name, amount, day] })
}
await exp(a1,'Abb. Vodafone',14.99,'11'); await exp(a1,'iPhone 16 Pro (Emily)',42.50,'5'); await exp(a1,'MacBook Air 15',40.73,'27')
await exp(a2,'Spotify',11.99,'1'); await exp(a2,'Apple iCloud',2.99,'16'); await exp(a2,'Apple iCloud (Mamma)',2.99,'10')
await exp(a2,'Google Storage 200GB',2.99,'14'); await exp(a2,'NordPass',1.89,'annuale'); await exp(a2,'Google Business (LLC)',7.02,'14')
await exp(a2,'Dominio (LLC)',0.75,'annuale'); await exp(a2,'Render',20.00,'14')
await exp(a3,'Affitto',1000.00,'15'); await exp(a3,'Bollette + Internet',125.00,'15'); await exp(a3,'Assistente Personale',350.00,'5'); await exp(a3,'Claude',89.00,'30')
await exp(a4,'Conto corrente',9.00,'5')

console.log('Seeded! Demo: demo / demo123')
process.exit(0)
