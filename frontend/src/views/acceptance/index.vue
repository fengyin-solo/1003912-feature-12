<template>
  <section class="page" data-module="acceptance">
    <!-- 打开中的会签批次：整页切到会签台 -->
    <CountersignDesk
      v-if="activeBatchId !== null"
      :batch-id="activeBatchId"
      @close="closeDesk"
      @changed="handleDeskChanged"
    />

    <template v-else>
      <header class="page-head">
        <div>
          <h2>工程验收管理</h2>
          <p class="page-desc">勾选多份验收报告发起批量会签：先整批生成建议、再由组员逐条会签、最后形成结论；人工结论不回写原始记录。</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" :disabled="!selectedIds.length" @click="openDeskForSelection">
            发起批量会签{{ selectedIds.length ? `（已选 ${selectedIds.length} 份）` : '' }}
          </button>
          <button class="btn" type="button" @click="exportRows">导出工程验收清单</button>
        </div>
      </header>

      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <div v-if="errorMessage" class="error-panel">{{ errorMessage }}</div>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 36px"><input type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>会签状态</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td>
              <input
                type="checkbox"
                :checked="isSelected(row)"
                :disabled="!!batchOf(row.id)"
                @change="toggleOne(row)"
              />
            </td>
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>
              <span v-if="batchOf(row.id)">
                <button class="link" type="button" @click="activeBatchId = batchOf(row.id)!.id">
                  {{ batchOf(row.id)!.code }} · {{ batchOf(row.id)!.stage }}
                </button>
              </span>
              <span v-else class="muted-text">未会签</span>
            </td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 4" class="empty-state">暂无工程验收数据，可先登记验收报告</td>
          </tr>
        </tbody>
      </table>

      <section class="batch-list">
        <h3>会签批次</h3>
        <p v-if="!batches.length" class="muted-text">还没有会签批次，勾选上方报告后发起批量会签。</p>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>批次号</th><th>阶段</th><th>报告数</th><th>建议需整改</th><th>会签进度</th>
              <th>建批日期</th><th>结论日期</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>{{ batch.code }}</td>
              <td><span class="stage-tag">{{ batch.stage }}</span></td>
              <td>{{ batch.items.length }}</td>
              <td>{{ batch.items.filter((item) => item.suggestion === '需整改').length }}</td>
              <td>{{ batch.items.filter((item) => item.signed).length }}/{{ batch.items.length }}</td>
              <td>{{ batch.createdAt }}</td>
              <td>{{ batch.formedAt || '—' }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="activeBatchId = batch.id">
                  {{ batch.stage === '建议' ? '继续会签' : batch.stage === '会签' ? '继续会签' : '查看结论' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer class="page-foot">
        <span>共 {{ total }} 条工程验收记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { CountersignError, createBatch, listBatches } from '@/data/countersign'
import type { CountersignBatch } from '@/data/countersign-types'
import type { EntryRow } from '@/data/types'
import CountersignDesk from './CountersignDesk.vue'

const meta = moduleMeta('acceptance')
const columns = ["验收编号", "项目编号", "验收类型", "验收日期", "验收组成员", "整改项完成率", "有效期至", "验收结论", "验收状态"]
const actions = ["启动验收", "确认通过", "要求整改"]
const statuses = ["待验收", "验收中", "验收通过", "需整改", "已驳回"]
const stats = computed(() => [
  { label: "待验收项目", value: rows.value.filter((row) => String(row.status) === '待验收').length },
  { label: "通过项目数", value: rows.value.filter((row) => String(row.status) === '验收通过').length },
  { label: "整改中项目", value: rows.value.filter((row) => String(row.status) === '需整改').length },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["验收编号", "项目编号", "验收类型"]
const selectedIds = ref<number[]>([])
const batches = ref<CountersignBatch[]>([])
const activeBatchId = ref<number | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const batchByReport = computed(() => {
  const map = new Map<number, CountersignBatch>()
  for (const batch of batches.value) {
    for (const item of batch.items) {
      map.set(item.reportId, batch)
    }
  }
  return map
})

const selectableRows = computed(() => rows.value.filter((row) => !batchByReport.value.has(Number(row.id))))
const allChecked = computed(
  () => selectableRows.value.length > 0 &&
    selectableRows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)

function batchOf(reportId: number): CountersignBatch | undefined {
  return batchByReport.value.get(Number(reportId))
}

function isSelected(row: EntryRow): boolean {
  return selectedIds.value.includes(Number(row.id))
}

function toggleOne(row: EntryRow) {
  const id = Number(row.id)
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? selectableRows.value.map((row) => Number(row.id)) : []
}

function openDeskForSelection() {
  errorMessage.value = ''
  try {
    const batch = createBatch(selectedIds.value)
    selectedIds.value = []
    batches.value = listBatches()
    activeBatchId.value = batch.id
  } catch (error) {
    errorMessage.value =
      error instanceof CountersignError ? error.details.join('；') : '发起批量会签失败'
  }
}

function closeDesk() {
  activeBatchId.value = null
  reload()
}

function handleDeskChanged() {
  batches.value = listBatches()
  // 批次可能已被删除（无此场景），列表保持最新
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    batches.value = listBatches()
    selectedIds.value = selectedIds.value.filter((id) =>
      rows.value.some((row) => Number(row.id) === id) && !batchByReport.value.has(id),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工程验收列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.batch-list {
  margin-top: 18px;
}
.batch-list h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.stage-tag {
  background: #eef2f7;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
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
</style>
