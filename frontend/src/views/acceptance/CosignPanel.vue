<template>
  <section class="cosign-panel">
    <header class="cosign-head">
      <h3>批量会签台</h3>
      <p class="page-desc">
        勾选多份验收报告后整批生成建议，按「建议 → 会签 → 结论」顺序流转，跳级与归档后返工都会被拒绝。
        冲突优先级：现场会签结论优先于计算建议，凡不一致必须填写否决理由；结论只写入批次与状态流转，不改写报告原始记录。
      </p>
    </header>

    <p v-if="message" class="cosign-message" :class="{ error: messageIsError }">{{ message }}</p>
    <p v-if="!batches.length" class="empty-state">暂无会签批次，先在上方勾选验收报告并生成会签建议。</p>

    <article v-for="batch in batches" :key="batch.id" class="batch-card">
      <header class="batch-head">
        <strong>批次 {{ batch.id }}</strong>
        <span class="batch-status" :data-status="batch.status">{{ batch.status }}</span>
        <ol class="step-flow">
          <li v-for="(step, index) in steps" :key="step" :class="stepClass(batch, index)">{{ step }}</li>
        </ol>
        <span class="batch-time">更新于 {{ batch.updatedAt }}</span>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>验收编号</th>
            <th>验收类型</th>
            <th>整改完成率</th>
            <th>有效期至</th>
            <th>计算建议</th>
            <th>会签人</th>
            <th>现场结论</th>
            <th>否决理由</th>
            <th>最终结论</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in batch.items" :key="item.reportId">
            <td>{{ item.验收编号 }}</td>
            <td>{{ item.验收类型 }}</td>
            <td>
              {{ item.完成率 }}%
              <span class="cell-note">门槛 {{ item.门槛 }}%</span>
            </td>
            <td>
              {{ item.有效期至 }}
              <span v-if="item.已过期" class="cell-note conflict-note">已过期</span>
            </td>
            <td>
              <span class="suggest-tag" :data-v="item.建议">{{ item.建议 }}</span>
              <span class="cell-note">{{ item.建议说明 }}</span>
            </td>
            <template v-if="batch.status === '待会签'">
              <td>
                <input
                  v-model="draftOf(batch.id, item.reportId).会签人"
                  class="cosign-input"
                  placeholder="组员姓名"
                />
              </td>
              <td>
                <select v-model="draftOf(batch.id, item.reportId).现场结论" class="cosign-input">
                  <option value="">请选择</option>
                  <option v-for="option in conclusions" :key="option" :value="option">{{ option }}</option>
                </select>
              </td>
              <td>
                <input
                  v-model="draftOf(batch.id, item.reportId).否决理由"
                  class="cosign-input"
                  :class="{ conflict: isConflict(batch.id, item) }"
                  placeholder="与计算建议冲突时必填"
                />
                <span v-if="isConflict(batch.id, item)" class="conflict-note">与计算建议冲突，必填</span>
              </td>
              <td>—</td>
            </template>
            <template v-else>
              <td>{{ item.会签人 }}</td>
              <td><span class="suggest-tag" :data-v="item.现场结论">{{ item.现场结论 }}</span></td>
              <td>{{ item.否决理由 || '—' }}</td>
              <td>
                <template v-if="item.最终结论">
                  <span class="suggest-tag" :data-v="item.最终结论">{{ item.最终结论 }}</span>
                  <span class="cell-note">{{ item.结论说明 }}</span>
                </template>
                <template v-else>—</template>
              </td>
            </template>
          </tr>
        </tbody>
      </table>

      <footer class="batch-foot">
        <button v-if="batch.status === '待会签'" class="btn primary" type="button" @click="submitFor(batch)">
          提交会签
        </button>
        <button v-else-if="batch.status === '待结论'" class="btn primary" type="button" @click="finalize(batch.id)">
          形成结论并下发整改
        </button>
        <span v-else class="cell-note">批次已归档，结论只读，拒绝返工。</span>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { allBatches, finalizeBatch, submitCosign } from '@/api/countersign-service'
import { CONCLUSION_OPTIONS } from '@/data/countersign'
import type { CosignBatch, CosignBatchStatus, CosignConclusion, CosignItem } from '@/data/countersign'

const emit = defineEmits<{ changed: [] }>()

const steps = ['① 生成建议', '② 组员会签', '③ 形成结论']
const conclusions = CONCLUSION_OPTIONS
const STATUS_STEP: Record<CosignBatchStatus, number> = { 待会签: 1, 待结论: 2, 已结论: 3 }

type Draft = { 会签人: string; 现场结论: CosignConclusion | ''; 否决理由: string }

const batches = ref<CosignBatch[]>([])
const drafts = reactive<Record<string, Draft>>({})
const message = ref('')
const messageIsError = ref(false)

function draftKey(batchId: string, reportId: number): string {
  return `${batchId}:${reportId}`
}

function draftOf(batchId: string, reportId: number): Draft {
  const key = draftKey(batchId, reportId)
  if (!drafts[key]) {
    drafts[key] = { 会签人: '', 现场结论: '', 否决理由: '' }
  }
  return drafts[key]
}

function isConflict(batchId: string, item: CosignItem): boolean {
  const draft = drafts[draftKey(batchId, item.reportId)]
  return Boolean(draft && draft.现场结论 && draft.现场结论 !== item.建议)
}

function stepClass(batch: CosignBatch, index: number) {
  const current = STATUS_STEP[batch.status]
  return { active: index + 1 === current, done: index + 1 < current }
}

function syncDrafts() {
  for (const batch of batches.value) {
    for (const item of batch.items) {
      const key = draftKey(batch.id, item.reportId)
      if (!drafts[key]) {
        drafts[key] = { 会签人: item.会签人, 现场结论: item.现场结论, 否决理由: item.否决理由 }
      }
    }
  }
}

function refresh() {
  batches.value = allBatches()
  syncDrafts()
}

function show(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageIsError.value = !result.ok
}

function submitFor(batch: CosignBatch) {
  const entries = batch.items.map((item) => ({
    reportId: item.reportId,
    ...draftOf(batch.id, item.reportId),
  }))
  const result = submitCosign(batch.id, entries)
  show(result)
  refresh()
  if (result.ok) {
    emit('changed')
  }
}

function finalize(batchId: string) {
  const result = finalizeBatch(batchId)
  show(result)
  refresh()
  // 结论会联动验收状态与整改任务，成败都通知列表刷新
  emit('changed')
}

onMounted(refresh)
defineExpose({ refresh })
</script>
