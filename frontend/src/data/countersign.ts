/**
 * 批量会签台领域服务（纯前端实现，接口形状按后端可替换的方式组织）。
 *
 * 硬性规则：
 * 1. 多选报告必须「先建议 → 再会签 → 最后结论」，禁止跳级；批次归档后拒绝一切返工。
 * 2. 会签台只读验收报告原件，人工结论存于批次，绝不回写验收记录。
 * 3. 现场结论与计算建议冲突时「从严优先、放宽留痕」：
 *    - 建议「需整改」、现场填「通过」属放宽冲突，必须填否决理由，最终仍按更严的「需整改」；
 *    - 建议「通过」、现场填「需整改」属从严冲突，直接采纳更严的现场结论。
 * 4. 结论形成时整批落库：任一条校验失败，批次与整改任务全部不写入（整批回退）。
 * 5. 整改跟踪页按批次号整批接收整改事项；同一报告只允许存在一版未归档会签，已归档不可返工。
 */
import { listRows, saveRows } from './local-store'
import type { CountersignBatch, CountersignItem, CountersignVerdict } from './countersign-types'
import type { EntryRow } from './types'

const ACCEPTANCE_KEY = 'acceptance'
const RECTIFICATION_KEY = 'rectification'
const STORAGE_KEY = 'geohazard-monitor-prevention:countersign'

/** 业务基准日：有效期判定按此日期比较（演示数据口径固定为当前业务日）。 */
export const BUSINESS_DATE = '2026-10-05'
const TODAY = BUSINESS_DATE

/** 不同验收类型的整改项完成率门槛：低于门槛即建议「需整改」。 */
const COMPLETION_THRESHOLDS: Array<{ typePrefix: string; threshold: number }> = [
  { typePrefix: '竣工验收', threshold: 1 },
  { typePrefix: '专项验收', threshold: 0.9 },
  { typePrefix: '初步验收', threshold: 0.85 },
  { typePrefix: '阶段性验收', threshold: 0.8 },
  { typePrefix: '分部分项验收', threshold: 0.7 },
]
const DEFAULT_THRESHOLD = 0.9

export class CountersignError extends Error {
  details: string[]
  constructor(details: string[]) {
    super(details.join('；'))
    this.name = 'CountersignError'
    this.details = details
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function todayText(): string {
  return TODAY
}

function thresholdOf(type: string): number {
  const hit = COMPLETION_THRESHOLDS.find((rule) => type.startsWith(rule.typePrefix))
  return hit ? hit.threshold : DEFAULT_THRESHOLD
}

/** 整改项完成率兼容 0.92 与「92%」两种填法，无法解析按 0 处理（从严）。 */
export function parseCompletion(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1 ? value / 100 : value
  }
  const text = String(value ?? '').trim()
  if (!text) {
    return 0
  }
  const numeric = Number(text.replace('%', ''))
  if (!Number.isFinite(numeric)) {
    return 0
  }
  return text.includes('%') || numeric > 1 ? numeric / 100 : numeric
}

function asText(value: unknown): string {
  return String(value ?? '').trim()
}

type Suggestion = { verdict: CountersignVerdict; reasons: string[]; rate: number; validUntil: string }

/** 按验收类型门槛、整改项完成率、有效期三项事实整批生成建议（机器结论）。 */
export function buildSuggestion(row: EntryRow): Suggestion {
  const type = asText(row['验收类型']) || '未分类验收'
  const rate = parseCompletion(row['整改项完成率'])
  const validUntil = asText(row['有效期至'])
  const threshold = thresholdOf(type)
  const reasons: string[] = []
  if (!validUntil) {
    reasons.push('未登记有效期，无法确认验收效力')
  } else if (validUntil < TODAY) {
    reasons.push(`验收结论有效期至 ${validUntil}，已过期`)
  }
  if (rate < threshold) {
    reasons.push(
      `整改项完成率 ${(rate * 100).toFixed(0)}%，低于「${type}」门槛 ${(threshold * 100).toFixed(0)}%`,
    )
  }
  const verdict: CountersignVerdict = reasons.length ? '需整改' : '通过'
  if (verdict === '通过') {
    reasons.push(`完成率 ${(rate * 100).toFixed(0)}% 达标，有效期至 ${validUntil}，在有效期内`)
  }
  return { verdict, reasons, rate, validUntil }
}

/** 冲突判定：建议需整改而现场通过＝放宽（需否决理由，仍从严）；反之为从严（直接采纳）。 */
export type ConflictKind = 'none' | 'loosen' | 'tighten'

export function conflictOf(item: CountersignItem): ConflictKind {
  if (!item.siteVerdict || item.siteVerdict === item.suggestion) {
    return 'none'
  }
  return item.suggestion === '需整改' && item.siteVerdict === '通过' ? 'loosen' : 'tighten'
}

/** 最终人工结论：机器建议与现场结论不一致时，更严的「需整改」始终优先。 */
export function finalVerdictOf(item: Pick<CountersignItem, 'suggestion' | 'siteVerdict'>): CountersignVerdict {
  if (item.siteVerdict === '') {
    return item.suggestion
  }
  return item.suggestion === '需整改' || item.siteVerdict === '需整改' ? '需整改' : '通过'
}

function loadBatchesRaw(): CountersignBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CountersignBatch[]) : []
  } catch {
    return []
  }
}

function persistBatches(batches: CountersignBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
}

export function listBatches(): CountersignBatch[] {
  return loadBatchesRaw().sort((a, b) => b.id - a.id)
}

export function getBatch(id: number): CountersignBatch {
  const batch = loadBatchesRaw().find((item) => item.id === id)
  if (!batch) {
    throw new CountersignError([`没有找到编号为 ${id} 的会签批次`])
  }
  return batch
}

function nextBatchId(batches: CountersignBatch[]): number {
  return batches.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function batchCode(id: number): string {
  return `CS-${TODAY.replace(/-/g, '')}-${String(id).padStart(3, '0')}`
}

/** 建批：勾选多份验收报告，立刻整批生成建议，进入「建议」阶段。 */
export function createBatch(reportIds: number[]): CountersignBatch {
  const errors: string[] = []
  const ids = reportIds.map((id) => Number(id))
  if (ids.length === 0) {
    throw new CountersignError(['请至少勾选一份验收报告'])
  }
  if (new Set(ids).size !== ids.length) {
    errors.push('勾选清单里有重复报告，一份报告在一个批次内只能出现一次')
  }

  const rows = listRows(ACCEPTANCE_KEY)
  const batches = loadBatchesRaw()
  const items: CountersignItem[] = []

  for (const id of ids) {
    const row = rows.find((entry) => Number(entry.id) === id)
    if (!row) {
      errors.push(`编号 ${id} 的验收报告不存在或已被删除`)
      continue
    }
    const code = asText(row['验收编号']) || `#${id}`
    const occupied = batches.find((batch) => batch.items.some((item) => item.reportId === id))
    if (occupied) {
      if (occupied.stage === '已归档') {
        errors.push(`报告 ${code} 已随批次 ${occupied.code} 归档，归档后不允许返工`)
      } else {
        errors.push(`报告 ${code} 已在批次 ${occupied.code}（${occupied.stage}）中，同一报告重复会签只留一版`)
      }
      continue
    }
    const suggestion = buildSuggestion(row)
    items.push({
      reportId: id,
      验收编号: code,
      验收类型: asText(row['验收类型']),
      completionRate: suggestion.rate,
      validUntil: suggestion.validUntil,
      suggestion: suggestion.verdict,
      suggestionReasons: suggestion.reasons,
      siteVerdict: '',
      vetoReason: '',
      signer: '',
      signed: false,
    })
  }

  if (errors.length) {
    // 建批阶段同样整批回退：一条不满足，整份建议清单都不生成。
    throw new CountersignError(errors)
  }

  const id = nextBatchId(batches)
  const batch: CountersignBatch = {
    id,
    code: batchCode(id),
    stage: '建议',
    createdAt: todayText(),
    formedAt: '',
    archivedAt: '',
    items,
  }
  persistBatches([...batches, batch])
  return batch
}

/** 建议 → 会签：只允许从「建议」阶段进入，其他阶段拒绝，杜绝跳级。 */
export function beginCountersign(id: number): CountersignBatch {
  const batches = loadBatchesRaw()
  const batch = getBatch(id)
  if (batch.stage !== '建议') {
    throw new CountersignError([`批次 ${batch.code} 当前为「${batch.stage}」，只有「建议」阶段才能进入会签`])
  }
  batch.stage = '会签'
  persistBatches(batches.map((item) => (item.id === id ? batch : item)))
  return batch
}

function requireStage(batch: CountersignBatch, stage: string): void {
  if (batch.stage !== stage) {
    throw new CountersignError([`批次 ${batch.code} 当前为「${batch.stage}」，该操作要求处于「${stage}」阶段`])
  }
}

type ItemPatch = Partial<Pick<CountersignItem, 'siteVerdict' | 'vetoReason' | 'signer' | 'signed'>>

/** 校验单条会签：放宽冲突必须填否决理由；确认签署时组员与现场结论都不能缺。 */
function validateItem(item: CountersignItem): string[] {
  const label = `报告 ${item.验收编号}`
  const errors: string[] = []
  if (!item.signer.trim()) {
    errors.push(`${label} 未填写会签组员`)
  }
  if (!item.siteVerdict) {
    errors.push(`${label} 未选择现场结论`)
  }
  if (conflictOf(item) === 'loosen' && !item.vetoReason.trim()) {
    errors.push(`${label} 现场「通过」否决了建议「需整改」，必须逐条填写否决理由后方可签署`)
  }
  return errors
}

/** 组员逐条保存会签内容；点「确认签署」时做该条全字段校验。 */
export function saveItemSign(batchId: number, reportId: number, patch: ItemPatch): CountersignBatch {
  const batches = loadBatchesRaw()
  const batch = getBatch(batchId)
  requireStage(batch, '会签')
  const item = batch.items.find((entry) => entry.reportId === reportId)
  if (!item) {
    throw new CountersignError([`批次 ${batch.code} 中找不到该报告`])
  }
  const next: CountersignItem = {
    ...item,
    ...patch,
    siteVerdict: patch.siteVerdict === undefined ? item.siteVerdict : patch.siteVerdict,
    vetoReason: patch.vetoReason === undefined ? item.vetoReason : patch.vetoReason.trim(),
    signer: patch.signer === undefined ? item.signer : patch.signer.trim(),
  }
  if (next.signed) {
    const errors = validateItem(next)
    if (errors.length) {
      throw new CountersignError(errors)
    }
  }
  batch.items = batch.items.map((entry) => (entry.reportId === reportId ? next : entry))
  persistBatches(batches.map((entry) => (entry.id === batchId ? batch : entry)))
  return batch
}

function rectificationRowsOf(batch: CountersignBatch): EntryRow[] {
  const rows = listRows(ACCEPTANCE_KEY)
  const current = listRows(RECTIFICATION_KEY)
  let nextId = current.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const created: EntryRow[] = []
  for (const item of batch.items) {
    if (finalVerdictOf(item) !== '需整改') {
      continue
    }
    const source = rows.find((row) => Number(row.id) === item.reportId)
    nextId += 1
    const reasons = item.suggestion === '需整改' ? item.suggestionReasons : [item.vetoReason]
    created.push({
      id: nextId,
      status: '待整改',
      pending: true,
      abnormal: false,
      任务编号: `RECT-${String(nextId).padStart(4, '0')}`,
      验收编号: item.验收编号,
      整改内容: reasons.join('；'),
      责任单位: source ? asText(source['验收组成员']) || '待落实责任单位' : '待落实责任单位',
      整改期限: '2026-11-04',
      整改措施: `按会签批次 ${batch.code} 落实整改并申请复核`,
      复核人: '',
      整改状态: '',
      来源批次: batch.code,
    })
  }
  return created
}

/** 会签 → 结论：逐条校验，任一条失败整批回退；通过后按原批次整批下发整改事项。 */
export function formConclusion(batchId: number): CountersignBatch {
  const batches = loadBatchesRaw()
  const batch = clone(getBatch(batchId))
  requireStage(batch, '会签')

  const errors: string[] = []
  if (batch.items.length === 0) {
    errors.push(`批次 ${batch.code} 没有任何报告，不能形成结论`)
  }
  for (const item of batch.items) {
    if (!item.signed) {
      errors.push(`报告 ${item.验收编号} 尚未完成组员会签`)
      continue
    }
    errors.push(...validateItem(item))
  }
  if (errors.length) {
    throw new CountersignError(errors)
  }

  batch.stage = '已形成'
  batch.formedAt = todayText()

  const nextBatches = batches.map((entry) => (entry.id === batchId ? batch : entry))
  const nextRectification = [...listRows(RECTIFICATION_KEY), ...rectificationRowsOf(batch)]
  commit(nextBatches, nextRectification, RECTIFICATION_KEY)
  return batch
}

/** 结论 → 归档：归档后整改事项保留、批次锁定，任何返工一律拒绝。 */
export function archiveBatch(batchId: number): CountersignBatch {
  const batches = loadBatchesRaw()
  const batch = getBatch(batchId)
  requireStage(batch, '已形成')
  batch.stage = '已归档'
  batch.archivedAt = todayText()
  persistBatches(batches.map((entry) => (entry.id === batchId ? batch : entry)))
  return batch
}

/**
 * 唯一受控返工入口：仅「已形成」且批次下发的整改事项都还停留在「待整改」时，
 * 可撤回重签，同时整批收回尚未启动的整改事项；已进入整改或已归档的，拒绝。
 */
export function withdrawForResign(batchId: number): CountersignBatch {
  const batches = loadBatchesRaw()
  const batch = getBatch(batchId)
  requireStage(batch, '已形成')
  const owned = listRows(RECTIFICATION_KEY).filter((row) => asText(row['来源批次']) === batch.code)
  const started = owned.filter((row) => asText(row.status) !== '待整改')
  if (started.length) {
    throw new CountersignError([
      `批次 ${batch.code} 已有 ${started.length} 项整改进入流转（${started
        .map((row) => asText(row['任务编号']))
        .join('、')}），不能撤回重签`,
    ])
  }
  batch.stage = '会签'
  batch.formedAt = ''
  batch.items = batch.items.map((item) => ({ ...item, signed: false }))
  const nextBatches = batches.map((entry) => (entry.id === batchId ? batch : entry))
  const nextRectification = listRows(RECTIFICATION_KEY).filter((row) => asText(row['来源批次']) !== batch.code)
  commit(nextBatches, nextRectification, RECTIFICATION_KEY)
  return batch
}

/** 跨存储提交：批次与整改清单一起落库，任一步失败恢复现场，保证整批原子性。 */
function commit(nextBatches: CountersignBatch[], nextRows: EntryRow[], rowKey: string): void {
  const prevBatches = loadBatchesRaw()
  const prevRows = listRows(rowKey)
  try {
    persistBatches(nextBatches)
    saveRows(rowKey, nextRows)
  } catch (error) {
    persistBatches(prevBatches)
    saveRows(rowKey, prevRows)
    throw error
  }
}
