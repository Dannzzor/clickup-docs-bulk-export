import * as fs from 'fs'
import * as path from 'path'
import { ClickUpClient } from './clickup/client.js'
import type {
  ClickUpDoc,
  ExportIssue,
  ExportOptions,
  ExportProgressEvent,
  ExportResult,
} from './clickup/types.js'
import { sanitizeFilename } from './utils/sanitize.js'
import { Logger } from './utils/logger.js'

const LISTING_CACHE_SUBDIR = '.clickup-export'
const LISTING_CACHE_FILE = 'page-listing.json'

export class ClickUpExporter {
  private client: ClickUpClient
  private logger: Logger
  private options: ExportOptions
  private exportedPages: number = 0
  private errors: string[] = []
  private issues: ExportIssue[] = []
  private pageDelay: number
  /** Maps resolved doc root dir → ClickUp doc id (disambiguate same-name docs in one run) */
  private docDirAllocations = new Map<string, string>()

  constructor(options: ExportOptions) {
    this.options = options
    this.client = new ClickUpClient(options.token)
    this.logger = new Logger(options.verbose)
    this.pageDelay = options.pageDelay ?? 100
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private listingCachePath(docDir: string): string {
    return path.join(docDir, LISTING_CACHE_SUBDIR, LISTING_CACHE_FILE)
  }

  private relOutput(absPath: string): string {
    const root = path.resolve(this.options.outputDir)
    return path.relative(root, path.resolve(absPath)) || '.'
  }

  private recordIssue(issue: ExportIssue, includeInLegacyErrors: boolean): void {
    this.issues.push(issue)
    if (includeInLegacyErrors) {
      this.errors.push(formatIssueLine(issue))
    }
    if (issue.kind !== 'resume_skipped_content') {
      this.emit({ type: 'issue', issue })
    }
  }

  private emit(event: ExportProgressEvent): void {
    this.options.onProgress?.(event)
  }

  async export(): Promise<ExportResult> {
    const { workspaceId, outputDir, docId } = this.options

    this.ensureDir(outputDir)
    this.docDirAllocations.clear()
    this.emit({ type: 'phase', phase: 'start', message: 'Starting export' })

    this.logger.info('Verifying workspace access...')
    this.emit({ type: 'phase', phase: 'workspaces', message: 'Verifying workspace access' })
    const workspaces = await this.client.getWorkspaces()

    const workspace = workspaces.find((w) => String(w.id) === String(workspaceId))
    if (!workspace && workspaces.length > 0) {
      const list = workspaces.map((w) => `${w.name} (${w.id})`).join(', ')
      this.logger.warn(
        `Workspace ID "${workspaceId}" is not in this token's workspace list: ${list}. ` +
          'Continuing with the ID you provided; if it is wrong you may get errors or empty results.'
      )
    } else if (!workspace && workspaces.length === 0) {
      this.logger.warn(
        'No workspaces returned for this token. Continuing with the provided workspace ID; verify API access.'
      )
    }

    let docs: ClickUpDoc[]

    if (docId) {
      this.logger.info(`Fetching doc ${docId}...`)
      this.emit({ type: 'phase', phase: 'single_doc', message: `Fetching doc ${docId}` })
      try {
        const doc = await this.client.getDoc(workspaceId, docId)
        docs = [doc]
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        this.recordIssue(
          {
            kind: 'target_doc_fetch',
            docId,
            reason: 'Failed to fetch single doc by ID',
            detail: msg,
          },
          true
        )
        docs = []
      }
    } else {
      this.logger.info('Fetching all docs (paginated)...')
      this.emit({ type: 'phase', phase: 'list_docs', message: 'Fetching workspace doc list' })
      try {
        docs = await this.client.getDocs(workspaceId, {
          includeArchived: this.options.includeArchived,
          includeDeleted: this.options.includeDeleted,
        })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        this.recordIssue(
          {
            kind: 'workspace_doc_list',
            docId: workspaceId,
            reason: 'Failed to list workspace docs',
            detail: msg,
          },
          true
        )
        docs = []
      }
    }

    this.logger.success(`Found ${docs.length} doc(s) to export`)
    this.emit({ type: 'docs_found', count: docs.length })

    const total = docs.length
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!
      this.emit({
        type: 'doc_start',
        docId: String(doc.id),
        docName: doc.name || 'unnamed-doc',
        index: i + 1,
        total,
      })
      await this.exportDoc(doc, workspaceId, outputDir)
      this.emit({
        type: 'doc_done',
        docId: String(doc.id),
        docName: doc.name || 'unnamed-doc',
      })
    }

    let reportJsonPath: string | undefined
    let reportMdPath: string | undefined
    if (!this.options.noReport) {
      this.emit({ type: 'phase', phase: 'reports', message: 'Writing export reports' })
      ;({ reportJsonPath, reportMdPath } = this.writeExportReports(outputDir, docs.length))
    }

    const result: ExportResult = {
      totalDocs: docs.length,
      totalPages: this.exportedPages,
      outputDir: path.resolve(outputDir),
      errors: this.errors,
      issues: this.issues,
      reportJsonPath,
      reportMdPath,
    }
    this.emit({ type: 'complete', result })
    return result
  }

  private async resolveDocDirectory(doc: ClickUpDoc, outputDir: string): Promise<string> {
    const name = sanitizeFilename(doc.name || 'unnamed-doc')
    const layout = this.options.layout ?? 'flat'
    let base: string
    if (layout !== 'hierarchy') {
      base = path.join(outputDir, name)
    } else {
      try {
        const segments = await this.client.getDocHierarchySegments(doc)
        const safe = segments.map((s) => sanitizeFilename(String(s)))
        base = path.join(outputDir, ...safe, name)
        const rel = path.relative(path.resolve(outputDir), path.resolve(base)) || name
        this.emit({
          type: 'phase',
          phase: 'hierarchy',
          message: segments.length ? `Folder: ${rel}` : `Folder: ${name} (workspace-level doc)`,
        })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        this.logger.warn(`Could not resolve ClickUp hierarchy for "${doc.name}", using flat folder: ${msg}`)
        base = path.join(outputDir, name)
      }
    }
    return this.allocateUniqueDocDir(base, String(doc.id))
  }

  private allocateUniqueDocDir(wanted: string, docId: string): string {
    const key = path.resolve(wanted)
    const existing = this.docDirAllocations.get(key)
    if (existing === docId) {
      return key
    }
    if (existing === undefined) {
      this.docDirAllocations.set(key, docId)
      return key
    }
    const short = docId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-10) || 'id'
    let candidate = path.join(path.dirname(key), `${path.basename(key)}-${short}`)
    let candidateKey = path.resolve(candidate)
    let n = 0
    while (this.docDirAllocations.has(candidateKey)) {
      if (this.docDirAllocations.get(candidateKey) === docId) {
        return candidateKey
      }
      n++
      candidate = path.join(path.dirname(key), `${path.basename(key)}-${short}-${n}`)
      candidateKey = path.resolve(candidate)
    }
    this.docDirAllocations.set(candidateKey, docId)
    return candidateKey
  }

  private async exportDoc(doc: ClickUpDoc, workspaceId: string, outputDir: string): Promise<void> {
    const docName = doc.name || 'unnamed-doc'
    const docId = String(doc.id)
    const docDir = await this.resolveDocDirectory(doc, outputDir)

    this.logger.info(`Exporting: ${docName}`)
    this.ensureDir(docDir)

    let pages: any[] = []
    const cachePath = this.listingCachePath(docDir)
    const cached = this.tryReadListingCache(cachePath)

    if (cached !== undefined && this.options.resume) {
      pages = cached
      this.logger.debug(`Using cached page listing: ${this.relOutput(cachePath)}`)
      this.emit({
        type: 'phase',
        phase: 'page_listing',
        message: `Using cached listing: ${this.relOutput(cachePath)}`,
      })
    } else {
      this.logger.debug(`Fetching page hierarchy for ${doc.id}...`)
      try {
        pages = await this.client.getPageListing(workspaceId, doc.id)
        this.writeListingCache(cachePath, pages)
        this.emit({
          type: 'file_written',
          relativePath: this.relOutput(cachePath),
          kind: 'listing_cache',
        })
        this.logger.debug(`Found ${this.countPagesRecursively(pages)} pages`)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        this.logger.warn(`Could not fetch pages: ${msg}`)
        this.recordIssue(
          {
            kind: 'doc_page_listing',
            docId,
            docName,
            reason: 'Could not fetch page listing from ClickUp',
            detail: msg,
            outputPath: this.relOutput(docDir),
          },
          true
        )
      }
    }

    if (pages.length === 0) {
      const content = this.generateDocContent(doc)
      const indexPath = path.join(docDir, 'index.md')
      this.writeMarkdownFile(indexPath, docName, content, { docId })
      this.emit({ type: 'file_written', relativePath: this.relOutput(indexPath), kind: 'markdown' })
      this.exportedPages++
      return
    }

    await this.exportPages(pages, workspaceId, doc.id, docName, docDir)
  }

  private tryReadListingCache(cachePath: string): any[] | undefined {
    if (!this.options.resume || !fs.existsSync(cachePath)) {
      return undefined
    }
    try {
      const raw = fs.readFileSync(cachePath, 'utf-8')
      const data = JSON.parse(raw) as unknown
      return Array.isArray(data) ? data : undefined
    } catch {
      return undefined
    }
  }

  private writeListingCache(cachePath: string, pages: any[]): void {
    this.ensureDir(path.dirname(cachePath))
    fs.writeFileSync(cachePath, JSON.stringify(pages, null, 0), 'utf-8')
  }

  private async exportPages(
    pages: any[],
    workspaceId: string,
    docId: string,
    docName: string,
    parentDir: string
  ): Promise<void> {
    for (const page of pages) {
      if (!page || !page.id) {
        this.recordIssue(
          {
            kind: 'page_skipped_invalid',
            docId,
            docName,
            reason: 'Page entry missing id (cannot map to ClickUp or output file)',
          },
          true
        )
        continue
      }

      const pageName = page.name || 'unnamed-page'
      const pageId = String(page.id)
      const children = page.children || page.sub_pages || page.pages || []
      const hasChildren = children.length > 0

      if (hasChildren) {
        const pageDir = path.join(parentDir, sanitizeFilename(pageName))
        this.ensureDir(pageDir)
        const indexPath = path.join(pageDir, 'index.md')
        await this.exportOnePageFile({
          docId,
          docName,
          pageId,
          pageName,
          absPath: indexPath,
          fetchContent: async () => {
            const pageData = await this.client.getPageContent(workspaceId, docId, page.id)
            return pageData?.content || pageData?.body || pageData?.markdown || ''
          },
          afterWrite: async () => {
            await this.exportPages(children, workspaceId, docId, docName, pageDir)
          },
        })
      } else {
        const filename = sanitizeFilename(pageName) + '.md'
        const absPath = path.join(parentDir, filename)
        await this.exportOnePageFile({
          docId,
          docName,
          pageId,
          pageName,
          absPath,
          fetchContent: async () => {
            const pageData = await this.client.getPageContent(workspaceId, docId, page.id)
            return pageData?.content || pageData?.body || pageData?.markdown || ''
          },
        })
      }

      this.logger.debug(`Exported: ${pageName}`)
    }
  }

  private async exportOnePageFile(args: {
    docId: string
    docName: string
    pageId: string
    pageName: string
    absPath: string
    fetchContent: () => Promise<string>
    afterWrite?: () => Promise<void>
  }): Promise<void> {
    const { docId, docName, pageId, pageName, absPath, fetchContent, afterWrite } = args
    const rel = this.relOutput(absPath)

    if (this.options.resume && fs.existsSync(absPath)) {
      this.recordIssue(
        {
          kind: 'resume_skipped_content',
          docId,
          docName,
          pageId,
          pageName,
          reason: 'Resume mode: file already exists; skipped page content API call and rewrite',
          outputPath: rel,
        },
        false
      )
      this.emit({ type: 'file_skipped', relativePath: rel, reason: 'resume' })
      this.exportedPages++
      if (afterWrite) {
        await afterWrite()
      }
      return
    }

    let content = ''
    try {
      content = await fetchContent()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      this.logger.debug(`Could not fetch content for "${pageName}": ${msg}`)
      this.recordIssue(
        {
          kind: 'page_content_fetch',
          docId,
          docName,
          pageId,
          pageName,
          reason: 'Failed to fetch page body from ClickUp',
          detail: msg,
          outputPath: rel,
        },
        true
      )
    }

    await this.delay(this.pageDelay)

    this.writeMarkdownFile(absPath, pageName, content, { docId, pageId })
    this.emit({ type: 'file_written', relativePath: rel, kind: 'markdown' })
    this.exportedPages++

    if (afterWrite) {
      await afterWrite()
    }
  }

  private generateDocContent(doc: ClickUpDoc): string {
    if (doc.content && Array.isArray(doc.content)) {
      return doc.content
        .filter((item) => item.type === 'markdown' || typeof item.content === 'string')
        .map((item) => item.content || '')
        .join('\n\n')
    }
    return ''
  }

  private writeMarkdownFile(
    filepath: string,
    title: string,
    content: string,
    meta?: { docId: string; pageId?: string }
  ): void {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const lines = [
      '---',
      `title: "${esc(title)}"`,
      `exported_at: "${new Date().toISOString()}"`,
    ]
    if (meta?.docId) {
      lines.push(`clickup_doc_id: "${esc(String(meta.docId))}"`)
    }
    if (meta?.pageId) {
      lines.push(`clickup_page_id: "${esc(String(meta.pageId))}"`)
    }
    lines.push('---', '')
    const finalContent = lines.join('\n') + (content || '*No content*')
    fs.writeFileSync(filepath, finalContent, 'utf-8')
  }

  private countPagesRecursively(pages: any[]): number {
    let count = 0
    for (const page of pages) {
      count++
      const children = page.children || page.sub_pages || page.pages || []
      if (children.length > 0) {
        count += this.countPagesRecursively(children)
      }
    }
    return count
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private writeExportReports(
    outputDir: string,
    totalDocsListed: number
  ): { reportJsonPath: string; reportMdPath: string } {
    const stamp = new Date().toISOString()
    const reportJsonPath = path.join(outputDir, 'export-report.json')
    const reportMdPath = path.join(outputDir, 'export-report.md')

    const problems = this.issues.filter((i) => i.kind !== 'resume_skipped_content')
    const resumeSkips = this.issues.filter((i) => i.kind === 'resume_skipped_content')

    const jsonPayload = {
      generated_at: stamp,
      output_dir: path.resolve(outputDir),
      summary: {
        total_docs: totalDocsListed,
        pages_written_or_resumed: this.exportedPages,
        problem_count: problems.length,
        resume_skip_count: resumeSkips.length,
        layout: this.options.layout ?? 'flat',
      },
      problems,
      resume_skips: resumeSkips,
    }

    fs.writeFileSync(reportJsonPath, JSON.stringify(jsonPayload, null, 2), 'utf-8')
    this.emit({
      type: 'file_written',
      relativePath: this.relOutput(reportJsonPath),
      kind: 'report_json',
    })

    const mdLines: string[] = [
      '# ClickUp docs export report',
      '',
      `Generated: ${stamp}`,
      '',
      '## Summary',
      '',
      `- Docs in this run: **${totalDocsListed}**`,
      `- Page files written or skipped (resume): **${this.exportedPages}**`,
      `- Problems (could not fully use API / invalid data): **${problems.length}**`,
      `- Resume skips (existing file, no API): **${resumeSkips.length}**`,
      `- Layout: **${this.options.layout ?? 'flat'}**`,
      '',
    ]

    if (problems.length === 0) {
      mdLines.push('## Problems', '', '_None._', '')
    } else {
      mdLines.push('## What we could not fully export (and why)', '')
      for (const g of groupIssues(problems)) {
        mdLines.push(`### ${g.title}`, '')
        for (const line of g.lines) {
          mdLines.push(`- ${line}`)
        }
        mdLines.push('')
      }
    }

    if (resumeSkips.length > 0) {
      mdLines.push(
        '## Resume mode',
        '',
        'These paths already had markdown on disk; the exporter did not call ClickUp again for their body.',
        ''
      )
      for (const i of resumeSkips.slice(0, 200)) {
        mdLines.push(`- **${i.docName ?? i.docId}** / ${i.pageName ?? i.pageId} — \`${i.outputPath ?? ''}\``)
      }
      if (resumeSkips.length > 200) {
        mdLines.push(`- _…and ${resumeSkips.length - 200} more (see export-report.json)._`)
      }
      mdLines.push('')
    }

    mdLines.push(
      '## Why documents can be missing',
      '',
      '- **Workspace list**: Previously only the first **100** docs were requested; this is now paginated. Re-run with a current build.',
      '- **Filters**: Archived or trashed docs are omitted unless you pass `--include-archived` or `--include-deleted`.',
      '- **Permissions**: Docs your token cannot read will fail at listing or page fetch; see problems above.',
      '- **Hierarchy layout**: Uses each doc\'s `parent` from ClickUp plus v2 Space/Folder/List APIs. Workspace-level or unknown parents export as a single doc folder under the output root (same as flat for that doc).',
      '- **Resume + cached listing**: With `--resume`, page structure is read from `.clickup-export/page-listing.json` when present; delete that file under a doc folder to force a fresh tree from ClickUp.',
      ''
    )

    fs.writeFileSync(reportMdPath, mdLines.join('\n'), 'utf-8')
    this.emit({
      type: 'file_written',
      relativePath: this.relOutput(reportMdPath),
      kind: 'report_md',
    })
    this.logger.info(`Wrote ${this.relOutput(reportJsonPath)} and ${this.relOutput(reportMdPath)}`)

    return { reportJsonPath, reportMdPath }
  }
}

function formatIssueLine(i: ExportIssue): string {
  const where = [i.docName ?? i.docId, i.pageName].filter(Boolean).join(' → ')
  const detail = i.detail ? ` (${i.detail})` : ''
  return `${where}: ${i.reason}${detail}`
}

function groupIssues(issues: ExportIssue[]): { title: string; lines: string[] }[] {
  const order: ExportIssue['kind'][] = [
    'workspace_doc_list',
    'target_doc_fetch',
    'doc_page_listing',
    'page_content_fetch',
    'page_skipped_invalid',
  ]
  const titles: Record<ExportIssue['kind'], string> = {
    workspace_doc_list: 'Workspace / doc list',
    target_doc_fetch: 'Single doc fetch',
    doc_page_listing: 'Page listing',
    page_content_fetch: 'Page content',
    page_skipped_invalid: 'Invalid page rows',
    resume_skipped_content: 'Resume',
  }
  const groups = new Map<ExportIssue['kind'], string[]>()
  for (const k of order) {
    groups.set(k, [])
  }
  for (const i of issues) {
    const bucket = groups.get(i.kind) ?? []
    const bit = [
      i.docName ? `Doc **${i.docName}** (${i.docId})` : `Doc \`${i.docId}\``,
      i.pageName ? `page **${i.pageName}** (\`${i.pageId}\`)` : '',
      i.outputPath ? `file \`${i.outputPath}\`` : '',
      `— ${i.reason}`,
      i.detail ? `— _${i.detail}_` : '',
    ]
      .filter(Boolean)
      .join(' ')
    bucket.push(bit)
    groups.set(i.kind, bucket)
  }
  return order
    .filter((k) => (groups.get(k) ?? []).length > 0)
    .map((k) => ({ title: titles[k], lines: groups.get(k) ?? [] }))
}
