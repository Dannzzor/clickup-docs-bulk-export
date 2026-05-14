import axios, { AxiosInstance, AxiosError } from 'axios'
import type { ClickUpWorkspace, ClickUpDoc } from './types.js'

/** ClickUp Public Docs API parent.type (see Create Doc reference) */
const PARENT_SPACE = 4
const PARENT_FOLDER = 5
const PARENT_LIST = 6
const PARENT_EVERYTHING = 7
const PARENT_WORKSPACE = 12

export class ClickUpClient {
  private api: AxiosInstance
  private v2Api: AxiosInstance | null = null
  private rateLimitDelay: number = 100 // ms between requests

  constructor(accessToken: string) {
    this.api = axios.create({
      baseURL: 'https://api.clickup.com/api/v3',
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
    })

    // Add request interceptor for rate limiting
    this.api.interceptors.request.use(async (config) => {
      await this.delay(this.rateLimitDelay)
      return config
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private getV2Api(): AxiosInstance {
    if (!this.v2Api) {
      this.v2Api = axios.create({
        baseURL: 'https://api.clickup.com/api/v2',
        headers: this.api.defaults.headers as Record<string, string>,
      })
      this.v2Api.interceptors.request.use(async (config) => {
        await this.delay(this.rateLimitDelay)
        return config
      })
    }
    return this.v2Api
  }

  private async v2Get<T>(url: string): Promise<T> {
    return this.handleRequest(async () => {
      const response = await this.getV2Api().get<T>(url)
      return response.data
    })
  }

  private async handleRequest<T>(request: () => Promise<T>): Promise<T> {
    let attempt = 0
    const maxServerRetries = 3
    
    while (true) {
      try {
        return await request()
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError<{ err: string; ECODE: string; error?: string }>
          const status = axiosError.response?.status
          
          // Rate limited (429) - always retry with exponential backoff
          if (status === 429) {
            attempt++
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000)
            await this.delay(delay)
            continue
          }
          
          // Server errors (5xx) - retry up to 3 times
          if (status && status >= 500 && attempt < maxServerRetries) {
            attempt++
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
            await this.delay(delay)
            continue
          }
          
          const errorMessage = 
            axiosError.response?.data?.err || 
            axiosError.response?.data?.error ||
            axiosError.message ||
            'ClickUp API error'
          throw new Error(errorMessage)
        }
        throw error
      }
    }
  }

  /**
   * Safe GET request with rate limit handling
   */
  async safeGet<T>(url: string, config?: any): Promise<T> {
    return this.handleRequest(async () => {
      const response = await this.api.get<T>(url, config)
      return response.data
    })
  }

  async getWorkspaces(): Promise<ClickUpWorkspace[]> {
    return this.handleRequest(async () => {
      try {
        const response = await this.api.get<{ workspaces: ClickUpWorkspace[] }>('/workspaces')
        return response.data.workspaces || []
      } catch (error) {
        // Fallback to v2 endpoint
        const v2Api = axios.create({
          baseURL: 'https://api.clickup.com/api/v2',
          headers: this.api.defaults.headers as Record<string, string>,
        })
        const response = await v2Api.get<{ teams: ClickUpWorkspace[] }>('/team')
        return response.data.teams
      }
    })
  }

  /**
   * List all docs in a workspace. Paginates until no more results (fixes the previous hard 100-doc cap).
   */
  async getDocs(
    workspaceId: string,
    filters?: { includeArchived?: boolean; includeDeleted?: boolean }
  ): Promise<ClickUpDoc[]> {
    const byId = new Map<string, ClickUpDoc>()
    let cursor: string | undefined
    let page = 0
    const maxIterations = 500

    for (let i = 0; i < maxIterations; i++) {
      const params: Record<string, string | number | boolean | undefined> = {
        deleted: filters?.includeDeleted === true,
        archived: filters?.includeArchived === true,
        limit: 100,
      }
      if (cursor) {
        params.cursor = cursor
      } else if (page > 0) {
        params.page = page
      }

      const body = await this.handleRequest(async () => {
        const response = await this.api.get<WorkspaceDocsResponse>(
          `/workspaces/${workspaceId}/docs`,
          { params }
        )
        return response.data
      })

      const batch = extractDocsFromWorkspaceDocsBody(body)
      let added = 0
      for (const d of batch) {
        if (d?.id && !byId.has(String(d.id))) {
          byId.set(String(d.id), d)
          added++
        }
      }

      if (batch.length === 0) {
        break
      }

      const nextCursor = pickNextCursor(body)
      if (nextCursor) {
        cursor = nextCursor
        page = 0
        continue
      }

      if (batch.length < 100) {
        break
      }

      // Full page but no cursor: try page-based pagination; stop if nothing new (API ignores page).
      if (added === 0) {
        break
      }
      cursor = undefined
      page++
    }

    return [...byId.values()]
  }

  async getDoc(workspaceId: string, docId: string): Promise<ClickUpDoc> {
    return this.handleRequest(async () => {
      const response = await this.api.get<any>(
        `/workspaces/${workspaceId}/docs/${docId}`
      )
      return response.data.doc || response.data
    })
  }

  async getPageListing(workspaceId: string, docId: string): Promise<any[]> {
    return this.handleRequest(async () => {
      const response = await this.safeGet<any>(
        `/workspaces/${workspaceId}/docs/${docId}/page_listing`,
        {
          params: {
            max_page_depth: -1, // Unlimited depth
          },
        }
      )
      
      if (Array.isArray(response)) {
        return response
      } else if (response?.pages) {
        return response.pages
      } else if (response?.children) {
        return response.children
      }
      return []
    })
  }

  async getPageContent(workspaceId: string, docId: string, pageId: string): Promise<any> {
    return this.handleRequest(async () => {
      const response = await this.api.get<any>(
        `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
        {
          params: {
            content_format: 'text/md',
          },
        }
      )
      return response.data
    })
  }

  /**
   * Resolve Space / Folder / List folder names for a doc (root → leaf order), using API v2.
   * Parent types per ClickUp: 4 Space, 5 Folder, 6 List, 7 Everything, 12 Workspace.
   */
  async getDocHierarchySegments(doc: ClickUpDoc): Promise<string[]> {
    const names: string[] = []
    let parent = extractParentRef(doc)
    for (let depth = 0; depth < 20 && parent; depth++) {
      const { id, type } = parent
      if (type === PARENT_WORKSPACE || type === PARENT_EVERYTHING) {
        break
      }
      if (type === PARENT_SPACE) {
        const space = unwrap(await this.v2Get<any>(`/space/${id}`))
        if (space?.name) {
          names.unshift(String(space.name))
        }
        break
      }
      if (type === PARENT_FOLDER) {
        const folder = unwrap(await this.v2Get<any>(`/folder/${id}`))
        if (folder?.name) {
          names.unshift(String(folder.name))
        }
        const sid = folder?.space?.id ?? folder?.space_id
        parent = sid != null ? { id: String(sid), type: PARENT_SPACE } : undefined
        continue
      }
      if (type === PARENT_LIST) {
        const list = unwrap(await this.v2Get<any>(`/list/${id}`))
        if (list?.name) {
          names.unshift(String(list.name))
        }
        const fid = list?.folder?.id ?? list?.folder_id
        const sid = list?.space?.id ?? list?.space_id
        if (fid != null && fid !== false) {
          parent = { id: String(fid), type: PARENT_FOLDER }
        } else if (sid != null) {
          parent = { id: String(sid), type: PARENT_SPACE }
        } else {
          parent = undefined
        }
        continue
      }
      break
    }
    return names
  }
}

function extractParentRef(doc: ClickUpDoc): { id: string; type: number } | undefined {
  const p = doc.parent as { id?: string | number; type?: string | number } | undefined
  if (!p || p.id == null || p.type == null) {
    return undefined
  }
  const type = typeof p.type === 'number' ? p.type : Number(p.type)
  if (!Number.isFinite(type)) {
    return undefined
  }
  return { id: String(p.id), type }
}

function unwrap(body: any): any {
  if (body?.list) return body.list
  if (body?.folder) return body.folder
  if (body?.space) return body.space
  return body
}

type WorkspaceDocsResponse = {
  docs?: ClickUpDoc[]
  data?: ClickUpDoc[]
  next_cursor?: string
  cursor?: string
  next_page_token?: string
  last_page?: boolean
  has_more?: boolean
}

function extractDocsFromWorkspaceDocsBody(body: WorkspaceDocsResponse): ClickUpDoc[] {
  if (Array.isArray(body)) {
    return body as unknown as ClickUpDoc[]
  }
  return body.docs ?? body.data ?? []
}

function pickNextCursor(body: WorkspaceDocsResponse): string | undefined {
  const c =
    body.next_cursor ??
    body.cursor ??
    body.next_page_token ??
    (body as { next?: string }).next
  if (typeof c === 'string' && c.length > 0) {
    return c
  }
  if (body.has_more === true && typeof (body as { next_page?: string }).next_page === 'string') {
    return (body as { next_page: string }).next_page
  }
  return undefined
}
