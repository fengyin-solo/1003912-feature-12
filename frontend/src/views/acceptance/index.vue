<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>工程验收管理</h2>
        <p class="page-desc">维护验收报告，围绕验收编号、项目编号、验收类型、验收日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="createCosignBatch">
          生成会签建议（{{ selectedIds.length }}）
        </button>
        <button class="btn" type="button" @click="openCreate">登记验收报告</button>
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
          <th class="check-col">
            <input type="checkbox" :checked="allEligibleSelected" @change="toggleAll" />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="check-col">
            <input
              v-model="selectedIds"
              type="checkbox"
              :value="Number(row.id)"
              :disabled="isLocked(row)"
              :title="isLocked(row) ? '已在未结会签批次中' : ''"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无工程验收数据，可先登记验收报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工程验收记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <CosignPanel ref="panelRef" @changed="onBatchChanged" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { createBatch, openBatchReportIds } from '@/api/countersign-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

import CosignPanel from './CosignPanel.vue'

const meta = moduleMeta('acceptance')
const columns = ["验收编号", "项目编号", "验收类型", "验收日期", "验收组成员", "验收结论", "整改意见", "验收状态"]
const actions = ["启动验收", "确认通过", "要求整改"]
const statuses = ["待验收", "验收中", "验收通过", "需整改", "已驳回"]
const stats = [{"label": "待验收项目", "value": 0}, {"label": "通过项目数", "value": 0}, {"label": "整改中项目", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const openIds = ref<Set<number>>(new Set())
const panelRef = ref<InstanceType<typeof CosignPanel> | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allEligibleSelected = computed(() => {
  const eligible = rows.value.filter((row) => !isLocked(row))
  return eligible.length > 0 && eligible.every((row) => selectedIds.value.includes(Number(row.id)))
})

function isLocked(row: EntryRow): boolean {
  return openIds.value.has(Number(row.id))
}

function toggleAll() {
  const eligible = rows.value.filter((row) => !isLocked(row)).map((row) => Number(row.id))
  if (allEligibleSelected.value) {
    selectedIds.value = selectedIds.value.filter((id) => !eligible.includes(id))
  } else {
    selectedIds.value = [...new Set([...selectedIds.value, ...eligible])]
  }
}

function refreshOpenIds() {
  openIds.value = openBatchReportIds()
}

function createCosignBatch() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = createBatch(selectedIds.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  selectedIds.value = []
  refreshOpenIds()
  panelRef.value?.refresh()
}

function onBatchChanged() {
  refreshOpenIds()
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '验收报告登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工程验收列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshOpenIds()
})
</script>
