import type { CosignBatch } from './countersign'

// 会签批次独立持久化：和台账数据分开存放，互不影响。
const STORAGE_KEY = 'geohazard-monitor-prevention:cosign-batches'

let cache: CosignBatch[] | null = null

function readStorage(): CosignBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as CosignBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function listBatches(): CosignBatch[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveBatches(batches: CosignBatch[]): void {
  cache = batches
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
}
