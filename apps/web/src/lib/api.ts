import type {
  DashboardDetail,
  DashboardListItem,
  DashboardRevisionSummary,
  GenerationDetailLevel,
  GenerationEvent,
  GenerationStatus,
  HealthResponse,
  RepositoryStatus,
  ContentLifecycleEvent,
  ContentPublicationSummary,
  ContentValidationRun,
} from '@fieldboard/contracts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw Object.assign(new Error(body.error ?? `Request failed (${response.status})`), { status: response.status })
  return body
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  listDashboards: () => request<{ items: DashboardListItem[]; nextCursor: string | null }>('/api/dashboards'),
  createGeneration: (prompt: string, detailLevel: GenerationDetailLevel = 'standard') => request<{ id: string }>('/api/generations', { method: 'POST', body: JSON.stringify({ prompt, detailLevel }) }),
  generation: (id: string) => request<GenerationStatus & { events: GenerationEvent[] }>(`/api/generations/${id}`),
  dashboard: (id: string, revision?: string) => request<DashboardDetail>(`/api/dashboards/${id}${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`),
  revisions: (id: string) => request<{ items: DashboardRevisionSummary[] }>(`/api/dashboards/${id}/revisions`),
  refine: (id: string, prompt: string, baseRevisionId: string, detailLevel: GenerationDetailLevel = 'standard') => request<{ id: string }>(`/api/dashboards/${id}/refinements`, { method: 'POST', body: JSON.stringify({ prompt, baseRevisionId, detailLevel }) }),
  restore: (id: string, revisionId: string) => request<{ revisionId: string; publicationId: string; status: string }>(`/api/dashboards/${id}/revisions/${revisionId}/restore`, { method: 'POST' }),
  refresh: (id: string, datasetIds?: string[]) => request<{ refreshed: string[] }>(`/api/dashboards/${id}/refresh`, { method: 'POST', body: JSON.stringify(datasetIds ? { datasetIds } : {}) }),
  repository: () => request<RepositoryStatus>('/api/repository'),
  repositoryDiff: (path: string) => request<{ path: string; diff: string }>(`/api/repository/diff?path=${encodeURIComponent(path)}`),
  startRepositoryValidation: (expectedHead: string | null, fingerprint: string) => request<{ id: string }>('/api/repository/validations', { method: 'POST', body: JSON.stringify({ expectedHead, fingerprint }) }),
  repositoryValidation: (id: string) => request<ContentValidationRun & { events: ContentLifecycleEvent[] }>(`/api/repository/validations/${id}`),
  importRepositoryChanges: (validationId: string, changeNote: string) => request<{ publicationIds: string[] }>('/api/repository/imports', { method: 'POST', body: JSON.stringify({ validationId, changeNote }) }),
  publication: (id: string) => request<ContentPublicationSummary & { events: ContentLifecycleEvent[] }>(`/api/publications/${id}`),
  retryPublication: (id: string) => request<ContentPublicationSummary>(`/api/publications/${id}/retry`, { method: 'POST' }),
}

export function followGeneration(
  id: string,
  onEvent: (event: GenerationEvent) => void,
  onTerminal: (status: GenerationStatus) => void,
  onError: (error: Error) => void,
): () => void {
  const source = new EventSource(`/api/generations/${id}/events`)
  const types: GenerationEvent['type'][] = ['queued', 'inspecting', 'querying', 'composing', 'validating', 'publishing', 'publication_blocked', 'completed', 'failed']
  for (const type of types) {
    source.addEventListener(type, (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as GenerationEvent
      onEvent(event)
      if (type === 'completed' || type === 'failed' || type === 'publication_blocked') {
        source.close()
        void api.generation(id).then(onTerminal).catch(onError)
      }
    })
  }
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onError(new Error('Generation event stream closed unexpectedly.'))
  }
  return () => source.close()
}

export function followRepositoryValidation(
  id: string,
  onEvent: (event: ContentLifecycleEvent) => void,
  onTerminal: (status: ContentValidationRun) => void,
  onError: (error: Error) => void,
): () => void {
  const source = new EventSource(`/api/repository/validations/${id}/events`)
  const types = ['queued', 'inspecting', 'validating', 'querying', 'valid', 'invalid', 'imported']
  for (const type of types) {
    source.addEventListener(type, (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as ContentLifecycleEvent
      onEvent(event)
      if (['valid', 'invalid', 'imported'].includes(type)) {
        source.close()
        void api.repositoryValidation(id).then(onTerminal).catch(onError)
      }
    })
  }
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onError(new Error('Repository validation stream closed unexpectedly.'))
  }
  return () => source.close()
}
