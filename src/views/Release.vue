<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const ready = computed(() => store.gatePassed)
const nextVersion = ref('v26.10')
const routeTarget = ref('R-04')

function bumpDevice(deviceId: string, label: string) {
  store.changeVersion('device', deviceId, nextVersion.value, label)
}
function bumpStation() {
  store.changeVersion('station', 'STATION', nextVersion.value, '全站联锁软件升级')
}
function bumpRoute() {
  store.changeVersion('route', routeTarget.value, nextVersion.value, `进路 ${routeTarget.value} 联锁关系修订`)
}
function ledgerType(entry: { ok: boolean; replay: boolean }) {
  return !entry.ok ? 'error' : entry.replay ? 'warning' : 'success'
}
</script>

<template>
  <section class="page-head">
    <div>
      <p class="eyebrow">发布门禁 · 版本失效 · 证据重算</p>
      <h1>基线锁定与测试报告</h1>
      <p>设备或进路版本变化只让关联步骤失效，封存证据保留；确认修订后按有效证据重算门禁，重放不重复计票。</p>
    </div>
    <n-space>
      <n-button @click="store.exportPackage">导出测试报告</n-button>
      <n-button @click="store.resetAll">重置演示数据</n-button>
      <n-button type="primary" :disabled="!ready || store.baselineLocked" @click="store.lockBaseline">锁定发布基线</n-button>
    </n-space>
  </section>

  <!-- 修订控制条 -->
  <article class="card revision-bar">
    <div class="panel-head">
      <div>
        <h2>版本修订闭环</h2>
        <p>当前全站 {{ store.stationVersion }}（已确认基线 {{ store.confirmedStationVersion }}）</p>
      </div>
      <n-space align="center">
        <n-tag :type="store.revision === '稳定' ? 'success' : 'warning'" size="large">{{ store.revision }}</n-tag>
        <n-button type="primary" ghost :disabled="store.revision === '稳定'" @click="store.confirmRevision">确认修订并重算门禁</n-button>
        <n-button @click="store.recalc">立即重算</n-button>
      </n-space>
    </div>
    <n-space wrap>
      <n-input v-model:value="nextVersion" style="width: 120px" placeholder="新版本号" />
      <n-button v-for="d in store.changedDevices" :key="d.deviceId" type="warning" ghost @click="bumpDevice(d.deviceId, d.label)">
        模拟 {{ d.label }} 升至 {{ nextVersion }}
      </n-button>
      <n-select v-model:value="routeTarget" :options="store.routes.map((r) => ({ label: `${r.id} ${r.name}`, value: r.id }))" style="width: 200px" />
      <n-button @click="bumpRoute">模拟进路 {{ routeTarget }} 修订</n-button>
      <n-button type="error" ghost @click="bumpStation">模拟全站升级到 {{ nextVersion }}</n-button>
    </n-space>
    <n-alert style="margin-top: 10px" type="warning" :show-icon="true">
      版本变化后：关联步骤标记「失效待重测」，在办签出转只读、未提交内容进只读草稿；已封存证据不删除，确认修订后只采信与当前版本一致的有效证据。
    </n-alert>
  </article>

  <!-- 重算结果 -->
  <article class="card" style="margin-top: 16px">
    <div class="panel-head">
      <div>
        <h2>重算结果（发布门禁）</h2>
        <p>计算于 {{ store.tally?.computedAt ?? '—' }} · 修订确认状态：{{ store.tally?.confirmed ? '已确认' : '未确认' }}</p>
      </div>
      <n-tag :type="ready ? 'success' : 'error'" size="large">{{ ready ? '门禁通过 · 可发布' : '门禁阻断' }}</n-tag>
    </div>
    <div class="metrics" style="margin-bottom: 8px">
      <article class="card metric"><span>步骤总数</span><strong>{{ store.tally?.totalSteps ?? 0 }}</strong><small>全部用例</small></article>
      <article class="card metric"><span>有效通过证据</span><strong>{{ store.tally?.passedWithEvidence ?? 0 }}</strong><small>按当前版本采信</small></article>
      <article class="card metric"><span>有效证据总数</span><strong>{{ store.tally?.validEvidenceCount ?? 0 }}</strong><small>含失败证据</small></article>
      <article class="card metric"><span>失效待重测</span><strong>{{ store.tally?.invalidSteps ?? 0 }}</strong><small>关联版本变化</small></article>
    </div>
    <n-alert :type="ready ? 'success' : 'error'" style="margin-bottom: 12px"
      :title="ready ? '全部用例具备当前版本有效通过证据，可锁定' : '发布门禁未通过'"
      :description="ready ? '设备快照、执行证据和失败闭环均完整。' : (store.tally?.reasons.slice(0, 4).join('；') || '存在未闭环项')" />
    <div v-for="t in store.tally?.cases" :key="t.caseId" class="gate">
      <div>
        <b>{{ t.caseId }}</b>
        <small>{{ t.reasons.slice(0, 2).join('；') || '有效证据齐全' }}</small>
      </div>
      <n-space :size="6" align="center">
        <n-tag size="small">有效 {{ t.validEvidenceCount }}/{{ t.stepCount }}</n-tag>
        <n-tag size="small" type="warning" v-if="t.invalidCount">失效 {{ t.invalidCount }}</n-tag>
        <n-tag :type="t.status === '通过' ? 'success' : t.status === '失败' ? 'error' : 'warning'">{{ t.status }}</n-tag>
      </n-space>
    </div>
  </article>

  <div class="grid-2" style="margin-top: 16px">
    <article class="card">
      <div class="panel-head"><div><h2>差异与影响范围</h2><p>仅关联进路/用例失效，不扩大回归面</p></div><n-tag>2 项设备变更</n-tag></div>
      <div v-for="d in store.changedDevices" :key="d.deviceId" class="diff">
        <b>{{ d.label }} · 当前 {{ store.deviceVersions[d.deviceId] }}</b>
        <p>{{ d.impact }}</p>
      </div>
      <n-divider />
      <n-result :status="store.baselineLocked ? 'success' : 'info'"
        :title="store.baselineLocked ? `${store.stationVersion} 已锁定` : '等待门禁通过'"
        :description="store.baselineLocked ? '报告、证据链与账本指纹已签章。' : '锁定后生成只读版本快照。'" />
    </article>

    <!-- 账本：按请求号可重放，展示幂等去重 -->
    <article class="card">
      <div class="panel-head"><div><h2>写入账本（请求号 → 幂等）</h2><p>按请求号重放返回原结果，不重复封存证据/计票</p></div><n-tag>{{ store.ledger.length }} 条</n-tag></div>
      <div class="ledger-list">
        <div v-for="entry in store.ledger.slice(0, 18)" :key="entry.at + entry.requestId" class="ledger-item">
          <div class="draft-head">
            <n-tag size="tiny" :type="ledgerType(entry)">{{ entry.ok ? '成功' : '拒绝' }}</n-tag>
            <b class="ledger-cmd">{{ entry.command }}</b>
            <n-tag v-if="entry.replay" size="tiny" type="warning">重放</n-tag>
            <n-button size="tiny" quaternary @click="store.replayLedgerRequest(entry.original?.requestId ?? entry.requestId.split('#')[0])">重放该请求</n-button>
          </div>
          <small class="muted">{{ entry.requestId }} · {{ entry.at?.slice(11, 19) }} · {{ entry.message }}</small>
          <small v-if="entry.fingerprint" class="muted">指纹 {{ entry.fingerprint }}</small>
        </div>
      </div>
    </article>
  </div>
</template>
