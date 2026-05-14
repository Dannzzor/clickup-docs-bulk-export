import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

const LS_TOKEN = 'clickup_dashboard_token'
const LS_WS = 'clickup_dashboard_workspace'
const LS_OUT = 'clickup_dashboard_output'
const LS_DOC = 'clickup_dashboard_doc'
const LS_LAYOUT = 'clickup_dashboard_layout'

function stripFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  return m ? source.slice(m[0].length) : source
}

function ts(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false })
}

type LogTone = 'ok' | 'warn' | 'err' | undefined

type ProgressEvent = {
  type: string
  [k: string]: unknown
}

export function App() {
  const [token, setToken] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [outputDir, setOutputDir] = useState('./clickup-docs')
  const [docId, setDocId] = useState('')
  const [resume, setResume] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [skipReport, setSkipReport] = useState(false)
  const [hierarchyLayout, setHierarchyLayout] = useState(false)

  const [files, setFiles] = useState<string[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [rawMd, setRawMd] = useState('')

  const [exporting, setExporting] = useState(false)
  const [logs, setLogs] = useState<{ t: string; text: string; tone?: LogTone }[]>([])
  const [summary, setSummary] = useState<{
    totalDocs: number
    totalPages: number
    problemCount: number
  } | null>(null)

  const logEndRef = useRef<HTMLDivElement>(null)

  const pushLog = useCallback((text: string, tone?: LogTone) => {
    setLogs((prev) => [...prev, { t: ts(), text, tone }])
  }, [])

  useEffect(() => {
    setToken(localStorage.getItem(LS_TOKEN) ?? '')
    setWorkspaceId(localStorage.getItem(LS_WS) ?? '')
    setOutputDir(localStorage.getItem(LS_OUT) ?? './clickup-docs')
    setDocId(localStorage.getItem(LS_DOC) ?? '')
    setHierarchyLayout(localStorage.getItem(LS_LAYOUT) === 'hierarchy')
  }, [])

  const persist = useCallback(() => {
    localStorage.setItem(LS_TOKEN, token)
    localStorage.setItem(LS_WS, workspaceId)
    localStorage.setItem(LS_OUT, outputDir)
    localStorage.setItem(LS_DOC, docId)
    localStorage.setItem(LS_LAYOUT, hierarchyLayout ? 'hierarchy' : 'flat')
  }, [token, workspaceId, outputDir, docId, hierarchyLayout])

  const loadTree = useCallback(async () => {
    try {
      const q = new URLSearchParams({ root: outputDir })
      const res = await fetch(`/api/tree?${q}`)
      const data = (await res.json()) as { files?: string[]; error?: string }
      if (!res.ok) {
        pushLog(`Tree error: ${data.error ?? res.status}`, 'err')
        setFiles([])
        return
      }
      setFiles(data.files ?? [])
    } catch (e) {
      pushLog(`Tree error: ${e instanceof Error ? e.message : String(e)}`, 'err')
      setFiles([])
    }
  }, [outputDir, pushLog])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const loadFile = useCallback(
    async (rel: string) => {
      setSelectedPath(rel)
      try {
        const q = new URLSearchParams({ root: outputDir, path: rel })
        const res = await fetch(`/api/file?${q}`)
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          setRawMd(`_Could not load file (${j.error ?? res.status})_`)
          return
        }
        setRawMd(await res.text())
      } catch (e) {
        setRawMd(`_Error: ${e instanceof Error ? e.message : String(e)}_`)
      }
    },
    [outputDir]
  )

  const mdBody = useMemo(() => stripFrontmatter(rawMd), [rawMd])

  const runExport = async () => {
    persist()
    setExporting(true)
    setSummary(null)
    pushLog('Starting export…', 'ok')
    try {
      const res = await fetch('/api/export/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          workspaceId: workspaceId.trim(),
          outputDir: outputDir.trim() || './clickup-docs',
          docId: docId.trim() || undefined,
          resume,
          includeArchived,
          includeDeleted,
          skipReport,
          layout: hierarchyLayout ? 'hierarchy' : 'flat',
        }),
      })

      if (res.status === 409) {
        pushLog('Another export is already running.', 'warn')
        return
      }
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        pushLog(`Export failed to start: ${res.status} ${errText}`, 'err')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const handleEvent = (ev: ProgressEvent) => {
        switch (ev.type) {
          case 'phase':
            pushLog(`[${String(ev.phase)}] ${String(ev.message ?? '')}`.trim())
            break
          case 'docs_found':
            pushLog(`Found ${Number(ev.count)} doc(s) in workspace`, 'ok')
            break
          case 'doc_start':
            pushLog(
              `Doc ${Number(ev.index)}/${Number(ev.total)} — ${String(ev.docName)}`,
              'ok'
            )
            break
          case 'doc_done':
            pushLog(`Finished — ${String(ev.docName)}`)
            break
          case 'file_written':
            pushLog(`Wrote (${String(ev.kind)}) ${String(ev.relativePath)}`, 'ok')
            break
          case 'file_skipped':
            pushLog(`Skipped (resume) ${String(ev.relativePath)}`, 'warn')
            break
          case 'issue': {
            const issue = ev.issue as Record<string, unknown> | undefined
            const kind = String(issue?.kind ?? 'issue')
            const reason = String(issue?.reason ?? '')
            const detail = issue?.detail != null ? ` — ${String(issue.detail)}` : ''
            pushLog(`Issue [${kind}] ${reason}${detail}`, 'warn')
            break
          }
          case 'complete': {
            const result = ev.result as Record<string, unknown> | undefined
            const totalDocs = Number(result?.totalDocs ?? 0)
            const totalPages = Number(result?.totalPages ?? 0)
            const issues = (result?.issues as unknown[]) ?? []
            const problems = issues.filter((i) => {
              const o = i as { kind?: string }
              return o?.kind !== 'resume_skipped_content'
            })
            setSummary({ totalDocs, totalPages, problemCount: problems.length })
            pushLog(
              `Complete — ${totalDocs} docs, ${totalPages} page files, ${problems.length} problem(s)`,
              problems.length ? 'warn' : 'ok'
            )
            void loadTree()
            break
          }
          case 'fatal':
            pushLog(`Fatal: ${String(ev.message)}`, 'err')
            break
          default:
            pushLog(JSON.stringify(ev))
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const block of parts) {
          const line = block.trim()
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          try {
            handleEvent(JSON.parse(json) as ProgressEvent)
          } catch {
            pushLog(`Bad SSE chunk: ${json.slice(0, 120)}`, 'err')
          }
        }
      }
    } catch (e) {
      pushLog(e instanceof Error ? e.message : String(e), 'err')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <h1>ClickUp docs export</h1>
          <p>
            Run exports from the browser, watch files stream in, then browse markdown with GitHub-flavored
            rendering. API runs locally; your token stays in this tab unless you save it below.
          </p>
        </div>
        <div className="badge">
          <span className={exporting ? 'dot busy' : 'dot'} />
          {exporting ? 'Export running' : 'Ready'}
        </div>
      </header>

      <div className="main-grid">
        <section className="panel">
          <div className="panel-header">Export</div>
          <div className="panel-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="token">API token</label>
                <input
                  id="token"
                  type="password"
                  autoComplete="off"
                  placeholder="or set CLICKUP_API_TOKEN in .env"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onBlur={persist}
                />
              </div>
              <div className="field">
                <label htmlFor="ws">Workspace ID</label>
                <input
                  id="ws"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  onBlur={persist}
                  placeholder="e.g. 1234567"
                />
              </div>
              <div className="field">
                <label htmlFor="out">Output folder</label>
                <input
                  id="out"
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  onBlur={persist}
                />
              </div>
              <div className="field">
                <label htmlFor="doc">Single doc ID (optional)</label>
                <input
                  id="doc"
                  value={docId}
                  onChange={(e) => setDocId(e.target.value)}
                  onBlur={persist}
                  placeholder="Leave empty for all docs"
                />
              </div>
              <div className="row-checks">
                <label>
                  <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                  Resume
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeArchived}
                    onChange={(e) => setIncludeArchived(e.target.checked)}
                  />
                  Include archived
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeDeleted}
                    onChange={(e) => setIncludeDeleted(e.target.checked)}
                  />
                  Include deleted
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={hierarchyLayout}
                    onChange={(e) => setHierarchyLayout(e.target.checked)}
                  />
                  Hierarchy folders (Space / Folder / List)
                </label>
                <label>
                  <input type="checkbox" checked={skipReport} onChange={(e) => setSkipReport(e.target.checked)} />
                  Skip report files
                </label>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="button" disabled={exporting} onClick={() => void runExport()}>
                  Run export
                </button>
                <button className="btn btn-ghost" type="button" disabled={exporting} onClick={() => void loadTree()}>
                  Refresh file list
                </button>
              </div>
            </div>

            <div className="file-list">
              <div className="panel-header" style={{ border: 'none', padding: '0 0 8px' }}>
                Markdown files ({files.length})
              </div>
              <ul>
                {files.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      className={f === selectedPath ? 'active' : ''}
                      onClick={() => void loadFile(f)}
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="panel-header">Preview</div>
          <div className="panel-body">
            <div className="md-pane">
              {!selectedPath ? (
                <div className="empty-md">Select a markdown file from the list to preview it here.</div>
              ) : (
                <article className="md-article">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {mdBody || '_Empty file_'}
                  </ReactMarkdown>
                </article>
              )}
            </div>
            <div className="log-pane">
              {logs.length === 0 ? (
                <div className="log-line">Activity from the export will appear here.</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={`log-line ${l.tone ?? ''}`}>
                    <span style={{ opacity: 0.55 }}>[{l.t}]</span> {l.text}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
          {summary && (
            <div className="summary-bar">
              <span>
                Last run: <strong>{summary.totalDocs}</strong> docs, <strong>{summary.totalPages}</strong> pages
              </span>
              <span>
                Problems (excl. resume): <strong>{summary.problemCount}</strong>
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
