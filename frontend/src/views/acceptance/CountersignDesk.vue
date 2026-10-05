<template>
  <section v-if="batch" class="desk">
    <header class="desk-head">
      <div>
        <h3>批量会签台 · {{ batch.code }}</h3>
        <p class="page-desc">
          建批 {{ batch.createdAt }}<template v-if="batch.formedAt"> · 形成结论 {{ batch.formedAt }}</template>
          <template v-if="batch.archivedAt"> · 归档 {{ batch.archivedAt }}</template>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="emit('close')">返回报告列表</button>
      </div>
    </header>

    <ol class="step-bar">
      <li v-for="step in steps" :key="step" :class="{ active: step === batch.stage, done: stepIndex(step) < stepIndex(batch.stage) }">
        {{ step }}
      </li>
    </ol>

    <div v-if="errorDetails.length" class="error-panel">
      <strong>整批回退，未写入任何数据：</strong>
      <ul>
        <li v-for="detail in errorDetails" :key="detail">{{ detail }}</li>
      </ul>
    </div>

    <!-- 阶段一：建议（机器整批生成，只展示事实与依据） -->
    <template v-if="batch.stage === '建议'">
      <p class="rule-note">
        已按「验收类型门槛 + 整改项完成率 + 有效期」整批生成计算建议；建议一旦生成即定型，不可手工改写，原始验收记录也保持不变。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>验收编号</th><th>验收类型</th><th>整改项完成率</th><th>有效期至</th><th>计算建议</th><th>建议依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in batch.items" :key="item.reportId">
            <td>{{ item.验收编号 }}</td>
            <td>{{ item.验收类型 }}</td>
            <td :class="rateClass(item)">{{ (item.completionRate * 100).toFixed(0) }}%</td>
            <td :class="validityClass(item)">{{ item.validUntil || '未登记' }}</td>
            <td><span :class="['verdict', item.suggestion === '通过' ? 'pass' : 'reject']">{{ item.suggestion }}</span></td>
            <td class="reason-cell">{{ item.suggestionReasons.join('；') }}</td>
          </tr>
        </tbody>
      </table>
      <div class="desk-actions">
        <button class="btn primary" type="button" @click="run(() => beginCountersign(batch.id))">
          建议无误，进入会签
        </button>
        <span class="hint">跳级保护：必须先看建议，才能开展逐条会签。</span>
      </div>
    </template>

    <!-- 阶段二：会签（组员逐条填现场结论与否决理由） -->
    <template v-else-if="batch.stage === '会签'">
      <p class="rule-note">
        冲突优先顺序：现场结论与计算建议不一致时<strong>从严优先</strong>——现场比建议更严直接采纳；
        现场比建议宽（建议「需整改」却填「通过」）必须填写否决理由，最终仍按更严的「需整改」出结论。
      </p>
      <div class="desk-actions">
        <span class="hint">会签进度：{{ signedCount }}/{{ batch.items.length }} 条已签署</span>
        <button class="btn primary" type="button" @click="requestConclusion">全部会签完成，整批形成结论</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 96px">验收编号</th>
            <th style="width: 120px">类型/事实</th>
            <th style="width: 150px">计算建议</th>
            <th style="width: 150px">现场结论</th>
            <th>否决理由</th>
            <th style="width: 120px">会签组员</th>
            <th style="width: 110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in batch.items" :key="item.reportId" :class="{ signed: item.signed }">
            <td>{{ item.验收编号 }}</td>
            <td class="fact-cell">
              {{ item.验收类型 }}<br />
              <span :class="rateClass(item)">{{ (item.completionRate * 100).toFixed(0) }}%</span>
              · <span :class="validityClass(item)">{{ item.validUntil || '无有效期' }}</span>
            </td>
            <td>
              <span :class="['verdict', item.suggestion === '通过' ? 'pass' : 'reject']">{{ item.suggestion }}</span>
              <p class="mini-note">{{ item.suggestionReasons.join('；') }}</p>
            </td>
            <td>
              <select
                v-if="!item.signed"
                :value="item.siteVerdict"
                @change="patchItem(item, { siteVerdict: ($event.target as HTMLSelectElement).value as CountersignVerdict })"
              >
                <option value="">请选择…</option>
                <option :value="item.suggestion">按建议（{{ item.suggestion }}）</option>
                <option value="通过">通过</option>
                <option value="需整改">需整改</option>
              </select>
              <span v-else :class="['verdict', finalVerdictOf(item) === '通过' ? 'pass' : 'reject']">
                {{ item.siteVerdict }}（最终：{{ finalVerdictOf(item) }}）
              </span>
              <p v-if="conflictOf(item) === 'loosen'" class="conflict loosen">放宽冲突：仍按「需整改」</p>
              <p v-else-if="conflictOf(item) === 'tighten'" class="conflict tighten">从严冲突：采纳现场「需整改」</p>
            </td>
            <td>
              <textarea
                v-if="!item.signed"
                :value="item.vetoReason"
                rows="2"
                placeholder="现场结论否决通过建议时必填"
                @input="patchItem(item, { vetoReason: ($event.target as HTMLTextAreaElement).value })"
              ></textarea>
              <span v-else>{{ item.vetoReason || '—' }}</span>
            </td>
            <td>
              <input
                v-if="!item.signed"
                :value="item.signer"
                placeholder="组员姓名"
                @input="patchItem(item, { signer: ($event.target as HTMLInputElement).value })"
              />
              <span v-else>{{ item.signer }}</span>
            </td>
            <td>
              <button v-if="!item.signed" class="btn" type="button" @click="confirmSign(item)">确认签署</button>
              <button v-else class="link" type="button" @click="patchItem(item, { signed: false })">修改</button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 阶段三/四：结论形成与归档（只读，绝不回写原件） -->
    <template v-else>
      <p class="rule-note">
        人工结论仅存于会签批次，验收报告原始记录未被改写；「需整改」事项已按批次 <strong>{{ batch.code }}</strong> 整批下发到整改跟踪页。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>验收编号</th><th>计算建议</th><th>现场结论</th><th>冲突处理</th><th>最终人工结论</th><th>否决理由</th><th>会签组员</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in batch.items" :key="item.reportId">
            <td>{{ item.验收编号 }}</td>
            <td><span :class="['verdict', item.suggestion === '通过' ? 'pass' : 'reject']">{{ item.suggestion }}</span></td>
            <td>{{ item.siteVerdict || '按建议' }}</td>
            <td>
              <p v-if="conflictOf(item) === 'loosen'" class="conflict loosen">放宽未予采纳，留痕后从严</p>
              <p v-else-if="conflictOf(item) === 'tighten'" class="conflict tighten">从严已采纳</p>
              <span v-else>一致</span>
            </td>
            <td><span :class="['verdict', finalVerdictOf(item) === '通过' ? 'pass' : 'reject']">{{ finalVerdictOf(item) }}</span></td>
            <td>{{ item.vetoReason || '—' }}</td>
            <td>{{ item.signer }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="batch.stage === '已形成'" class="desk-actions">
        <button class="btn primary" type="button" @click="run(() => archiveBatch(batch.id))">归档批次（锁定不可返工）</button>
        <button class="btn ghost" type="button" @click="withdraw">撤回重签（仅限整改事项尚未启动）</button>
      </div>
      <div v-else class="desk-actions">
        <span class="hint">批次已于 {{ batch.archivedAt }} 归档，跳级与返工均被拒绝。</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  archiveBatch,
  beginCountersign,
  BUSINESS_DATE,
  conflictOf,
  CountersignError,
  finalVerdictOf,
  formConclusion,
  getBatch,
  saveItemSign,
  withdrawForResign,
} from '@/data/countersign'
import type { BatchStage, CountersignBatch, CountersignItem, CountersignVerdict } from '@/data/countersign-types'

const props = defineProps<{ batchId: number }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const batch = ref<CountersignBatch>(getBatch(props.batchId))
const errorDetails = ref<string[]>([])

const steps: BatchStage[] = ['建议', '会签', '已形成', '已归档']
const stageIndex: Record<BatchStage, number> = { 建议: 0, 会签: 1, 已形成: 2, 已归档: 3 }
function stepIndex(stage: BatchStage): number {
  return stageIndex[stage]
}

const signedCount = computed(() => batch.value.items.filter((item) => item.signed).length)

function reload() {
  batch.value = getBatch(props.batchId)
  emit('changed')
}

function run(action: () => CountersignBatch) {
  errorDetails.value = []
  try {
    action()
    reload()
  } catch (error) {
    errorDetails.value = error instanceof CountersignError ? error.details : [String(error)]
  }
}

function patchItem(item: CountersignItem, patch: Partial<CountersignItem>) {
  errorDetails.value = []
  try {
    batch.value = saveItemSign(props.batchId, item.reportId, patch)
  } catch (error) {
    errorDetails.value = error instanceof CountersignError ? error.details : [String(error)]
  }
}

function confirmSign(item: CountersignItem) {
  run(() => saveItemSign(props.batchId, item.reportId, { signed: true }))
}

function requestConclusion() {
  run(() => formConclusion(props.batchId))
}

function withdraw() {
  if (window.confirm('撤回重签将整批收回尚未启动的整改事项，确认继续？')) {
    run(() => withdrawForResign(props.batchId))
  }
}

function rateClass(item: CountersignItem): string {
  return item.suggestion === '通过' ? 'ok-text' : 'warn-text'
}

function validityClass(item: CountersignItem): string {
  return item.validUntil && item.validUntil >= BUSINESS_DATE ? 'ok-text' : 'warn-text'
}
</script>

<style scoped>
.desk {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.desk-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.desk h3 {
  margin: 0;
}
.step-bar {
  display: flex;
  gap: 0;
  list-style: none;
  padding: 0;
  margin: 10px 0 14px;
}
.step-bar li {
  flex: 1;
  text-align: center;
  padding: 6px 0;
  font-size: 13px;
  color: var(--muted);
  background: #eef2f7;
  border-right: 1px solid #fff;
}
.step-bar li.active {
  background: var(--brand);
  color: #fff;
  font-weight: 600;
}
.step-bar li.done {
  background: #cfe3ff;
  color: #1f4e8c;
}
.rule-note {
  background: #f1f7ff;
  border: 1px solid #cfe3ff;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  margin: 0 0 12px;
}
.desk-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}
.hint {
  font-size: 12px;
  color: var(--muted);
}
.error-panel {
  border: 1px solid #f0a9a2;
  background: #fdecea;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 12px;
  font-size: 12.5px;
  color: #7a271a;
}
.error-panel ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.verdict {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
}
.verdict.pass {
  background: #dcf5e7;
  color: #166534;
}
.verdict.reject {
  background: #fdecea;
  color: #b42318;
}
.ok-text {
  color: #166534;
}
.warn-text {
  color: #b42318;
}
.reason-cell,
.fact-cell,
.mini-note {
  font-size: 12px;
  color: var(--muted);
}
.mini-note {
  margin: 4px 0 0;
}
.conflict {
  margin: 4px 0 0;
  font-size: 12px;
}
.conflict.loosen {
  color: #b42318;
}
.conflict.tighten {
  color: #1f6feb;
}
tr.signed {
  background: #f7fbf8;
}
textarea,
input,
select {
  width: 100%;
  font: inherit;
  font-size: 12.5px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
textarea {
  resize: vertical;
}
</style>
