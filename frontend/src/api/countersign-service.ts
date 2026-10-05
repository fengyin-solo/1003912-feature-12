import {
  COMPLETION_THRESHOLDS,
  DEFAULT_COMPLETION_THRESHOLD,
  DEFAULT_VALIDITY_DAYS,
  VALIDITY_DAYS,
} from '@/data/countersign'
import type { CosignBatch, CosignConclusion, CosignItem } from '@/data/countersign'
import { listBatches, saveBatches } from '@/data/countersign-store'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const ACCEPTANCE_KEY = 'acceptance'
const RECTIFICATION_KEY = 'rectification'
const ENGINEERING_KEY = 'engineering'

// 结论到验收报告状态的映射：只流转状态，不改写报告原始字段（验收结论、整改意见等保持原样）。
const CONCLUSION_STATUS: Record<CosignConclusion, { status: string; pending: boolean; abnormal: boolean }> = {
  通过: { status: '验收通过', pending: false, abnormal: false },
  需整改: { status: '需整改', pending: true, abnormal: false },
  不通过: { status: '已驳回', pending: false, abnormal: true },
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`)
  if (Number.isNaN(base.getTime())) {
    return date
  }
  base.setDate(base.getDate() + days)
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
}

/** 整改完成率：整改跟踪里该验收编号下「已整改/已复核」占比，没有整改任务视为 100%。 */
function rectificationRate(验收编号: string): { total: number; done: number; rate: number } {
  const tasks = listRows(RECTIFICATION_KEY).filter((row) => String(row['验收编号'] ?? '') === 验收编号)
  const done = tasks.filter((row) => ['已整改', '已复核'].includes(String(row.status))).length
  const rate = tasks.length === 0 ? 100 : Math.round((done / tasks.length) * 100)
  return { total: tasks.length, done, rate }
}

/** 计算建议：按验收类型定门槛与有效期，完成率不足建议整改，超有效期建议不通过。 */
export function computeSuggestion(
  report: EntryRow,
): Pick<CosignItem, '完成率' | '门槛' | '有效期至' | '已过期' | '建议' | '建议说明'> {
  const 验收编号 = String(report['验收编号'] ?? '')
  const 验收类型 = String(report['验收类型'] ?? '')
  const 验收日期 = String(report['验收日期'] ?? today())
  const stats = rectificationRate(验收编号)
  const 门槛 = COMPLETION_THRESHOLDS[验收类型] ?? DEFAULT_COMPLETION_THRESHOLD
  const validityDays = VALIDITY_DAYS[验收类型] ?? DEFAULT_VALIDITY_DAYS
  const 有效期至 = addDays(验收日期, validityDays)
  const 已过期 = 有效期至 < today()
  let 建议: CosignConclusion = '通过'
  let 建议说明 = `整改完成率 ${stats.rate}%（${stats.done}/${stats.total}）达到${验收类型 || '验收'}门槛 ${门槛}%，且在有效期内`
  if (已过期) {
    建议 = '不通过'
    建议说明 = `有效期至 ${有效期至}，已超出${验收类型 || '验收'}有效期 ${validityDays} 天`
  } else if (stats.rate < 门槛) {
    建议 = '需整改'
    建议说明 = `整改完成率 ${stats.rate}%（${stats.done}/${stats.total}）低于${验收类型 || '验收'}门槛 ${门槛}%`
  }
  return { 完成率: stats.rate, 门槛, 有效期至, 已过期, 建议, 建议说明 }
}

export function allBatches(): CosignBatch[] {
  return [...listBatches()].sort((a, b) => b.id.localeCompare(a.id))
}

/** 处于未结批次（待会签/待结论）中的报告 id，列表页用来禁止重复勾选。 */
export function openBatchReportIds(): Set<number> {
  const ids = new Set<number>()
  for (const batch of listBatches()) {
    if (batch.status === '已结论') {
      continue
    }
    for (const item of batch.items) {
      ids.add(item.reportId)
    }
  }
  return ids
}

/** 第一步「建议」：勾选的报告整批生成计算建议，批次进入待会签。 */
export function createBatch(reportIds: number[]): ActionResult & { batch?: CosignBatch } {
  const ids = [...new Set(reportIds)]
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选要会签的验收报告' }
  }
  const reports = listRows(ACCEPTANCE_KEY)
  const picked: EntryRow[] = []
  for (const id of ids) {
    const row = reports.find((item) => Number(item.id) === id)
    if (!row) {
      return { ok: false, message: `没有找到编号为 ${id} 的验收报告，整批未生成` }
    }
    picked.push(row)
  }
  const open = listBatches().filter((batch) => batch.status !== '已结论')
  for (const row of picked) {
    const holder = open.find((batch) => batch.items.some((item) => item.reportId === Number(row.id)))
    if (holder) {
      return { ok: false, message: `报告 ${row['验收编号']} 已在未结批次 ${holder.id} 中，请先完成该批次` }
    }
  }
  const date = today().replace(/-/g, '')
  const seq = listBatches().filter((batch) => batch.id.includes(`-${date}-`)).length + 1
  const batch: CosignBatch = {
    id: `CS-${date}-${pad(seq)}`,
    status: '待会签',
    createdAt: today(),
    updatedAt: today(),
    items: picked.map((row) => ({
      reportId: Number(row.id),
      验收编号: String(row['验收编号'] ?? ''),
      项目编号: String(row['项目编号'] ?? ''),
      验收类型: String(row['验收类型'] ?? ''),
      验收日期: String(row['验收日期'] ?? ''),
      ...computeSuggestion(row),
      会签人: '',
      现场结论: '',
      否决理由: '',
      最终结论: '',
      结论说明: '',
    })),
  }
  saveBatches([...listBatches(), batch])
  return { ok: true, message: `批次 ${batch.id} 已生成计算建议，请组织组员逐条会签`, batch }
}

export type CosignEntryInput = {
  reportId: number
  会签人: string
  现场结论: CosignConclusion | ''
  否决理由: string
}

/** 第二步「会签」：组员逐条给现场结论，与计算建议冲突时必须填否决理由。 */
export function submitCosign(batchId: string, entries: CosignEntryInput[]): ActionResult {
  const batches = listBatches()
  const batch = batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到会签批次 ${batchId}` }
  }
  if (batch.status === '已结论') {
    return { ok: false, message: `批次 ${batchId} 已归档，拒绝归档后返工` }
  }
  if (batch.status !== '待会签') {
    return { ok: false, message: `批次 ${batchId} 会签已提交，不能重复会签或跳级` }
  }
  const byReport = new Map(entries.map((entry) => [entry.reportId, entry]))
  for (const item of batch.items) {
    const entry = byReport.get(item.reportId)
    if (!entry || !entry.会签人.trim()) {
      return { ok: false, message: `报告 ${item.验收编号} 缺少会签人，组员须逐条会签` }
    }
    if (!entry.现场结论) {
      return { ok: false, message: `报告 ${item.验收编号} 缺少现场结论，不能跳过会签直接形成结论` }
    }
    if (entry.现场结论 !== item.建议 && !entry.否决理由.trim()) {
      return { ok: false, message: `报告 ${item.验收编号} 现场结论与计算建议冲突，必须填写否决理由` }
    }
  }
  const nextItems = batch.items.map((item) => {
    const entry = byReport.get(item.reportId) as CosignEntryInput
    return {
      ...item,
      会签人: entry.会签人.trim(),
      现场结论: entry.现场结论,
      否决理由: entry.否决理由.trim(),
    }
  })
  saveBatches(
    batches.map((item) =>
      item.id === batchId ? { ...item, items: nextItems, status: '待结论' as const, updatedAt: today() } : item,
    ),
  )
  return { ok: true, message: `批次 ${batchId} 会签完成，可以形成结论` }
}

function nextRectificationSeq(rows: EntryRow[]): number {
  return rows.reduce((max, row) => {
    const match = /^RECT-(\d+)$/.exec(String(row['任务编号'] ?? ''))
    return match ? Math.max(max, Number(match[1]) + 1) : max
  }, 1)
}

/**
 * 第三步「结论」：现场会签结论优先于计算建议，冲突留痕；
 * 整改事项按原批次下发整改跟踪，同一验收编号只留最新一版，任一条失败整批回退。
 */
export function finalizeBatch(batchId: string): ActionResult {
  const batches = listBatches()
  const batch = batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到会签批次 ${batchId}` }
  }
  if (batch.status === '已结论') {
    return { ok: false, message: `批次 ${batchId} 已归档，拒绝归档后返工` }
  }
  if (batch.status !== '待结论') {
    return { ok: false, message: `批次 ${batchId} 尚未完成会签，不能跳级形成结论` }
  }

  // 定结论：现场会签结论优先，与计算建议不一致时在说明里留痕。
  const concludedItems: CosignItem[] = batch.items.map((item) => {
    const 最终结论 = (item.现场结论 || item.建议) as CosignConclusion
    const 结论说明 =
      item.现场结论 && item.现场结论 !== item.建议
        ? `现场结论与计算建议（${item.建议}）冲突，按现场会签定为「${最终结论}」：${item.否决理由}`
        : `现场结论与计算建议一致：${item.建议说明}`
    return { ...item, 最终结论, 结论说明 }
  })

  const acceptanceRows = listRows(ACCEPTANCE_KEY)
  const rectificationRows = listRows(RECTIFICATION_KEY)
  const engineeringRows = listRows(ENGINEERING_KEY)

  // 整批预校验：任何一条失败都不写库。
  const reportIds = new Set(acceptanceRows.map((row) => Number(row.id)))
  const errors: string[] = []
  for (const item of concludedItems) {
    if (!reportIds.has(item.reportId)) {
      errors.push(`报告 ${item.验收编号} 原始记录已不存在`)
    }
    if (item.最终结论 === '需整改') {
      const 整改内容 = item.否决理由 || `按会签结论整改：${item.建议说明}`
      if (!整改内容.trim()) {
        errors.push(`报告 ${item.验收编号} 缺少整改内容`)
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, message: `整批回退：${errors[0]}（批次 ${batchId} 未写入任何结论与整改事项）` }
  }

  // 1) 验收报告只流转状态，原始字段不动。
  const nextAcceptance = acceptanceRows.map((row) => {
    const item = concludedItems.find((it) => it.reportId === Number(row.id))
    if (!item) {
      return row
    }
    const target = CONCLUSION_STATUS[item.最终结论 as CosignConclusion]
    return { ...row, status: target.status, pending: target.pending, abnormal: target.abnormal }
  })

  // 2) 整改事项按批次下发：同一验收编号只留最新一版，再追加本批任务。
  const batchCodes = new Set(concludedItems.map((item) => item.验收编号))
  const kept = rectificationRows.filter(
    (row) => !(row['会签批次'] && batchCodes.has(String(row['验收编号'] ?? ''))),
  )
  let seq = nextRectificationSeq(kept)
  let nextId = kept.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const deadline = addDays(today(), 30)
  const created: EntryRow[] = []
  for (const item of concludedItems) {
    if (item.最终结论 !== '需整改') {
      continue
    }
    const engineering = engineeringRows.find((row) => String(row['项目编号'] ?? '') === item.项目编号)
    const 责任单位 = String(engineering?.['承建方'] ?? '').trim() || '待指定责任单位'
    created.push({
      id: nextId++,
      status: '待整改',
      pending: true,
      abnormal: false,
      任务编号: `RECT-${String(seq++).padStart(4, '0')}`,
      验收编号: item.验收编号,
      整改内容: item.否决理由 || `按会签结论整改：${item.建议说明}`,
      责任单位,
      整改期限: deadline,
      整改措施: '待责任单位填报',
      复核人: item.会签人,
      整改状态: '待整改',
      会签批次: batch.id,
    })
  }

  // 3) 落库：任一写入异常都回滚到快照，保证整批原子性。
  try {
    saveRows(ACCEPTANCE_KEY, nextAcceptance)
    saveRows(RECTIFICATION_KEY, [...kept, ...created])
    saveBatches(
      batches.map((item) =>
        item.id === batchId ? { ...item, items: concludedItems, status: '已结论' as const, updatedAt: today() } : item,
      ),
    )
  } catch (error) {
    saveRows(ACCEPTANCE_KEY, acceptanceRows)
    saveRows(RECTIFICATION_KEY, rectificationRows)
    saveBatches(batches)
    return {
      ok: false,
      message: `整批回退：写入失败（${error instanceof Error ? error.message : '未知错误'}），数据已恢复原状`,
    }
  }
  return { ok: true, message: `批次 ${batchId} 结论已形成，${created.length} 项整改事项已按批次下发整改跟踪` }
}
