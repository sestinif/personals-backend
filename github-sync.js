import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'expenses.db')

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO = process.env.GITHUB_REPO || 'sestinif/personals-backend'
const DB_FILE = 'expenses.db'
const API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${DB_FILE}`

let fileSha = null

async function githubFetch(method, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'personals-backend',
    },
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  return fetch(API, opts)
}

export async function downloadDb() {
  if (!GITHUB_TOKEN) {
    console.log('[sync] No GITHUB_TOKEN, skipping download')
    return
  }
  try {
    const res = await githubFetch('GET')
    if (res.status === 200) {
      const data = await res.json()
      fileSha = data.sha
      const buffer = Buffer.from(data.content, 'base64')
      writeFileSync(DB_PATH, buffer)
      console.log(`[sync] DB downloaded from GitHub (${(buffer.length / 1024).toFixed(1)} KB)`)
    } else if (res.status === 404) {
      console.log('[sync] No DB on GitHub yet, will upload after first write')
    }
  } catch (err) {
    console.log('[sync] Download failed:', err.message)
  }
}

export async function uploadDb() {
  if (!GITHUB_TOKEN) return
  if (!existsSync(DB_PATH)) return

  try {
    const content = readFileSync(DB_PATH).toString('base64')
    const body = {
      message: 'Auto-sync DB',
      content,
    }
    if (fileSha) body.sha = fileSha

    const res = await githubFetch('PUT', body)
    if (res.ok) {
      const data = await res.json()
      fileSha = data.content.sha
      console.log('[sync] DB uploaded to GitHub')
    } else {
      const err = await res.text()
      console.log('[sync] Upload failed:', res.status, err)
    }
  } catch (err) {
    console.log('[sync] Upload error:', err.message)
  }
}
