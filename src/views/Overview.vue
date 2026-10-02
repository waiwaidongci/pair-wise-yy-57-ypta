<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { fetchStation } from '../api'
import { useTestStore } from '../store'
import { useExecutionSocket } from '../realtime'

const store = useTestStore()
const { data, isPending } = useQuery({ queryKey: ['station'], queryFn: fetchStation })
useExecutionSocket((value) => store.updateLiveProgress(value), (state) => { store.connection = state })

const stats = computed(() => [
  { label: '测试用例', value: store.cases.length, note: '关联 4 条基本进路' },
  { label: '有效通过证据', value: `${store.tally?.passedWithEvidence ?? 0}/${store.tally?.totalSteps ?? 0}`, note: '按当前版本采信计票' },
  { label: '失效待重测', value: store.tally?.invalidSteps ?? 0, note: store.revision === '稳定' ? '无版本失效' : '修订确认中' },
  { label: '待接续交班草稿', value: store.pendingDrafts.length, note: '换人未提交步骤' },
])

function statusType(status?: string) {
  return status === '通过' ? 'success' : status === '失败' ? 'error' : status === '阻塞' ? 'warning' : 'info'
}
</script>

<template>
  <section class="page-head">
    <div>
      <p class="eyebrow">版本升级与回归范围</p>
      <h1>联锁测试回归总览</h1>
      <p>签出唯一持有、证据封存留档、版本变化只失效关联步骤；门禁按有效证据重算。</p>
    </div>
    <n-button type="primary" @click="$router.push('/station')">查看站场受影响区域</n-button>
  </section>

  <n-alert v-if="store.revision !== '稳定'" type="warning" style="margin-bottom: 14px"
    title="设备/进路版本已变化，等待确认修订"
    >关联步骤已转「失效待重测」，封存证据保留；请到「基线与报告」确认修订后按有效证据重算门禁。</n-alert>

  <n-spin :show="isPending">
    <div class="metrics">
      <article v-for="item in stats" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article>
    </div>
    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>本轮变更影响</h2><p>基于设备关系图自动计算</p></div><n-tag type="warning">{{ data?.nextVersion }}</n-tag></div>
        <div v-for="change in store.changedDevices" :key="change.deviceId" class="change">
          <n-tag type="error">设备变更</n-tag>
          <div><b>{{ change.label }} · 当前 {{ store.deviceVersions[change.deviceId] }}</b><small>影响 R-02/R-04 关联用例 · 版本变化后只让关联步骤失效</small></div>
        </div>
        <n-alert type="warning" title="回归范围不能缩减" description="P-02 与 T-03 变更具有跨进路影响，只有版本控制负责人可审批范围例外。" />
      </article>

      <article class="card">
        <div class="panel-head">
          <div><h2>执行状态与当前持有者</h2><p>有效证据 {{ store.tally?.validEvidenceCount ?? 0 }} 份 · 进度 {{ store.progress }}%</p></div>
          <n-tag :type="store.gatePassed ? 'success' : 'warning'">{{ store.gatePassed ? '门禁通过' : '门禁阻断' }}</n-tag>
        </div>
        <n-progress type="line" :percentage="store.progress" :height="12" />
        <div v-for="item in store.cases" :key="item.id" class="case-row" @click="store.selectCase(item.id); $router.push('/execution')">
          <div>
            <b>{{ item.id }} · {{ item.name }}</b>
            <small>
              持有者：{{ store.holderOf(item.id)?.operator ?? '—' }}
              · {{ item.steps.filter((s) => !s.invalid).length }}/{{ item.steps.length }} 步有效
              · 关联 {{ item.routeIds.join(' / ') }}
            </small>
          </div>
          <n-tag :type="statusType(store.caseTally(item.id)?.status)">{{ store.caseTally(item.id)?.status ?? '—' }}</n-tag>
        </div>
      </article>
    </div>
  </n-spin>
</template>
