import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ClickUpExporter } from './exporter.js'
import type { ExportProgressEvent } from './clickup/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.CLICKUP_DASHBOARD_PORT || 8787)
const uiDir = path.join(__dirname, '..', 'dashboard', 'dist')

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '48kb' }))

let exportLock = false

function resolveRoot(raw: string): string {
  return path.resolve(process.cwd(), raw || './clickup-docs')
}

function isUnderRoot(root: string, filePath: string): boolean {
  const rootResolved = path.resolve(root)
  const targetResolved = path.resolve(filePath)
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep
  return targetResolved === rootResolved || targetResolved.startsWith(prefix)
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clickup-export-dashboard' })
})

app.get('/api/tree', (req, res) => {
  try {
    const root = resolveRoot(String(req.query.root ?? './clickup-docs'))
    if (!fs.existsSync(root)) {
      return res.json({ root, files: [] as string[] })
    }
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.md')) files.push(path.relative(root, full))
      }
    }
    walk(root)
    files.sort((a, b) => a.localeCompare(b))
    res.json({ root, files })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.get('/api/file', (req, res) => {
  try {
    const root = resolveRoot(String(req.query.root ?? './clickup-docs'))
    const rel = String(req.query.path ?? '')
    if (!rel || rel.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' })
    }
    const target = path.resolve(root, rel)
    if (!isUnderRoot(root, target)) {
      return res.status(400).json({ error: 'Path escapes output directory' })
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.type('text/markdown; charset=utf-8').send(fs.readFileSync(target, 'utf-8'))
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/api/export/stream', async (req, res) => {
  if (exportLock) {
    return res.status(409).json({ error: 'An export is already running' })
  }

  const body = req.body as Record<string, unknown> | undefined
  const token = (typeof body?.token === 'string' ? body.token : '').trim() || process.env.CLICKUP_API_TOKEN?.trim()
  const workspaceId = body?.workspaceId != null ? String(body.workspaceId) : ''
  const outputDir = body?.outputDir != null ? String(body.outputDir) : './clickup-docs'
  const docId = body?.docId != null && String(body.docId).trim() !== '' ? String(body.docId).trim() : undefined

  if (!token) {
    return res.status(400).json({ error: 'Missing API token (form or CLICKUP_API_TOKEN in .env)' })
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'Missing workspace ID' })
  }

  exportLock = true
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (event: ExportProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    const exporter = new ClickUpExporter({
      token,
      workspaceId,
      outputDir,
      docId,
      resume: Boolean(body?.resume),
      includeArchived: Boolean(body?.includeArchived),
      includeDeleted: Boolean(body?.includeDeleted),
      noReport: Boolean(body?.skipReport),
      pageDelay: typeof body?.pageDelay === 'number' ? body.pageDelay : 100,
      layout: body?.layout === 'hierarchy' ? 'hierarchy' : 'flat',
      verbose: false,
      onProgress: (e) => send(e),
    })
    await exporter.export()
  } catch (e) {
    send({ type: 'fatal', message: e instanceof Error ? e.message : String(e) })
  } finally {
    exportLock = false
    res.end()
  }
})

if (fs.existsSync(uiDir)) {
  app.use(express.static(uiDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next()
    }
    if (req.path.startsWith('/api')) {
      return next()
    }
    res.sendFile(path.join(uiDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`Dashboard server http://127.0.0.1:${PORT}`)
  if (!fs.existsSync(uiDir)) {
    console.warn(
      `No UI build at ${uiDir}. Run: npm run build --prefix dashboard, or use npm run dashboard (Vite on :5173).`
    )
  }
})
