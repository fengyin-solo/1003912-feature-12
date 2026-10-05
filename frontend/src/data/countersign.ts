/** 批量会签台的公共类型与计算规则：建议 → 会签 → 结论 三段流程共用的常量都放这里。 */

export type CosignConclusion = '通过' | '需整改' | '不通过'

export type CosignBatchStatus = '待会签' | '待结论' | '已结论'

export type CosignItem = {
  reportId: number
  验收编号: string
  项目编号: string
  验收类型: string
  验收日期: string
  /** 建议阶段计算：整改跟踪里该验收编号下「已整改/已复核」占比 */
  完成率: number
  /** 该验收类型要求的完成率门槛 */
  门槛: number
  /** 验收日期 + 类型有效期 */
  有效期至: string
  已过期: boolean
  建议: CosignConclusion
  建议说明: string
  /** 会签阶段由组员逐条填写 */
  会签人: string
  现场结论: CosignConclusion | ''
  否决理由: string
  /** 结论阶段形成，只写入批次，不改写报告原始记录 */
  最终结论: CosignConclusion | ''
  结论说明: string
}

export type CosignBatch = {
  id: string
  status: CosignBatchStatus
  createdAt: string
  updatedAt: string
  items: CosignItem[]
}

// 不同验收类型的有效期与完成率门槛：验收越正式，要求越严。
export const VALIDITY_DAYS: Record<string, number> = {
  竣工验收: 365,
  阶段验收: 180,
  专项验收: 90,
}
export const COMPLETION_THRESHOLDS: Record<string, number> = {
  竣工验收: 100,
  专项验收: 90,
  阶段验收: 80,
}
export const DEFAULT_VALIDITY_DAYS = 180
export const DEFAULT_COMPLETION_THRESHOLD = 100

// 冲突优先级（本系统约定）：现场会签结论 > 计算建议；凡不一致必须留否决理由，结论说明保留冲突痕迹。
export const CONFLICT_RULE =
  '现场会签结论优先于计算建议；两者不一致时必须填写否决理由，结论说明会保留冲突痕迹。'

export const CONCLUSION_OPTIONS: CosignConclusion[] = ['通过', '需整改', '不通过']
