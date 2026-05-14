export interface ClickUpWorkspace {
  id: string
  name: string
  color?: string
  avatar?: string
}

export interface ClickUpDoc {
  id: string
  name: string
  type?: 'doc' | 'wiki' | number
  date_created?: string | number
  date_updated?: string | number
  creator?: {
    id: string
    username: string
    email: string
  } | number
  content?: ClickUpDocContent[]
  children?: ClickUpDoc[]
  parent?: {
    id: string
    type?: number
  }
  pages?: ClickUpDocPage[]
  workspace_id?: number
  public?: boolean
  archived?: boolean
  deleted?: boolean
}

export interface ClickUpDocPage {
  id: string
  name?: string
  date_created?: string | number
  date_updated?: string | number
  content?: string | ClickUpDocContent[]
  body?: string
  markdown?: string
  order?: number
  children?: ClickUpDocPage[]
  sub_pages?: ClickUpDocPage[]
  pages?: ClickUpDocPage[]
}

export interface ClickUpDocContent {
  type: string
  content?: any
  attrs?: any
  pageId?: string
  pageName?: string
}

export interface ExportOptions {
  token: string
  workspaceId: string
  outputDir: string
  docId?: string
  verbose?: boolean
  /** Delay in ms between page content fetches to prevent API rate limiting (default: 100) */
  pageDelay?: number
  /** Skip API calls for page content (and optionally page listing) when local export already exists */
  resume?: boolean
  /** Include archived docs in workspace doc list (default: false, matches API filter) */
  includeArchived?: boolean
  /** Include deleted docs in workspace doc list (default: false) */
  includeDeleted?: boolean
  /** Do not write export-report.{json,md} under the output directory */
  noReport?: boolean
  /** Live progress for UIs and tooling (optional) */
  onProgress?: (event: ExportProgressEvent) => void
  /**
   * `flat` — one folder per doc under output (legacy).
   * `hierarchy` — mirror ClickUp location: Space / Folder / List (when present) / Doc name, using v2 API to resolve names.
   */
  layout?: 'flat' | 'hierarchy'
}

/** Streamed progress while an export runs */
export type ExportProgressEvent =
  | { type: 'phase'; phase: string; message?: string }
  | { type: 'docs_found'; count: number }
  | { type: 'doc_start'; docId: string; docName: string; index: number; total: number }
  | { type: 'doc_done'; docId: string; docName: string }
  | {
      type: 'file_written'
      relativePath: string
      kind: 'markdown' | 'listing_cache' | 'report_json' | 'report_md'
    }
  | { type: 'file_skipped'; relativePath: string; reason: 'resume' }
  | { type: 'issue'; issue: ExportIssue }
  | { type: 'complete'; result: ExportResult }
  | { type: 'fatal'; message: string }

/** Something we could not fully export, with a machine-readable reason */
export interface ExportIssue {
  kind:
    | 'workspace_doc_list'
    | 'target_doc_fetch'
    | 'doc_page_listing'
    | 'page_skipped_invalid'
    | 'page_content_fetch'
    | 'resume_skipped_content'
  docId: string
  docName?: string
  pageId?: string
  pageName?: string
  /** Relative path under outputDir when applicable */
  outputPath?: string
  reason: string
  /** API message or other technical detail */
  detail?: string
}

export interface ExportResult {
  totalDocs: number
  totalPages: number
  outputDir: string
  /** @deprecated Prefer `issues` — kept for backward compatibility (human-readable strings) */
  errors: string[]
  issues: ExportIssue[]
  reportJsonPath?: string
  reportMdPath?: string
}
