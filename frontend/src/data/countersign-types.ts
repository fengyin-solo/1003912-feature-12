/**
 * 批量会签台领域类型。
 *
 * 约定：人工结论（会签台）与原始验收记录是两套数据。
 * 会签全过程只读本模块的验收报告行，任何阶段都不回写验收表；
 * 结论形成后只向整改跟踪模块追加任务，验收报告原件保持登记时的样子。
 */

/** 会签口径只有两种结论：通过 / 需整改（需整改即否决通过，整改后可复验）。 */
export type CountersignVerdict = '通过' | '需整改'

/** 批次生命周期：先建议、再会签、最后结论，结论可归档；不允许跳级。 */
export type BatchStage = '建议' | '会签' | '已形成' | '已归档'

export type CountersignItem = {
  /** 关联验收报告 id（原始记录只读，不复制会被改写的字段）。 */
  reportId: number
  验收编号: string
  验收类型: string
  /** 生成建议时的事实快照：完成率与有效期；建议据此算出，之后不漂移。 */
  completionRate: number
  validUntil: string
  /** 计算建议（机器结论）及理由，建批时一次定型。 */
  suggestion: CountersignVerdict
  suggestionReasons: string[]
  /** 组员在会签台逐条填写的现场结论，缺省按建议走。 */
  siteVerdict: CountersignVerdict | ''
  /** 现场结论否决「通过建议」时逐条填写的否决理由，放宽冲突的留痕凭证。 */
  vetoReason: string
  /** 会签人（组员）逐条签署。 */
  signer: string
  signed: boolean
}

export type CountersignBatch = {
  id: number
  /** 批次号，整改跟踪页按它整批接收整改事项。 */
  code: string
  stage: BatchStage
  createdAt: string
  formedAt: string
  archivedAt: string
  items: CountersignItem[]
}
