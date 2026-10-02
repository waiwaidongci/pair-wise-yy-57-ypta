<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTestStore } from '../store'
import StepCheckoutRow from '../components/StepCheckoutRow.vue'

const store = useTestStore()

const operatorOptions = ['方瑜', '陆晨', '周衡', '当前用户'].map((label) => ({ label, value: label }))
const selectedCase = computed(() => store.selectedCase)
const holder = computed(() => (selectedCase.value ? store.holderOf(selectedCase.value.id) : undefined))
const caseCo = computed(() => store.selectedCaseCheckout)
const myCo = computed(() => store.myCheckout)
const caseTally = computed(() => (selectedCase.value ? store.caseTally(selectedCase.value.id) : undefined))
const tokenCurrent = computed(() => (selectedCase.value ? store.tokenOf(selectedCase.value.id) : ''))

const handoverTarget = ref('周衡')
const chaosMode = ref<'none' | 'offline' | 'timeout'>('none')
function applyChaos() {
  store.setChaosMode(chaosMode.value)
}
const chaosDesc = computed(() => ({
  none: '链路正常：写入即时封存并计票',
  offline: '发出前断网：请求进发件箱，服务端尚未收到',
  timeout: '应答丢失：服务端已写入，恢复时按请求号重放去重',
}[chaosMode.value]))

const myDrafts = computed(() => store.draftsForOperator(store.operator))
const caseDrafts = computed(() => (selectedCase.value ? store.draftsForCase(selectedCase.value.id) : []))

function draftTagType(state: string) {
  return state === '待接续' ? 'warning' : state === '已采用' ? 'success' : state === '已失效' ? 'error' : 'default'
}
</script>

<template>
  <section class="page-head">
    <div>
      <p class="eyebrow">步骤签出 · 执行证据 · 可恢复写入</p>
      <h1>回归执行记录</h1>
      <p>同一执行员同一时刻只持有一个有效签出；换人未提交步骤进交班草稿；证据只增不改，按请求号幂等重放。</p>
    </div>
    <n-space align="center">
      <n-tag :type="store.connection === '在线' ? 'success' : 'warning'">{{ store.connection }}</n-tag>
      <n-select :options="operatorOptions" :value="store.operator" style="width: 120px" @update:value="store.setOperator" />
    </n-space>
  </section>

  <div class="execution-grid">
    <!-- 左：当前用例签出与步骤 -->
    <article class="card">
      <div class="panel-head">
        <div>
          <h2>{{ selectedCase?.id }} 执行面板</h2>
          <p>{{ selectedCase?.name }} · 用例版本 {{ selectedCase?.version }} · 全站 {{ store.stationVersion }}
            <n-tag size="small" :type="store.revision === '稳定' ? 'success' : 'warning'" style="margin-left:6px">{{ store.revision }}</n-tag>
          </p>
        </div>
        <n-tag :type="caseTally?.status === '通过' ? 'success' : caseTally?.status === '失败' ? 'error' : 'warning'">
          {{ caseTally?.status ?? '—' }}
        </n-tag>
      </div>

      <!-- 当前持有者 -->
      <n-alert :type="holder ? 'info' : 'default'" class="holder-bar">
        <template #header>
          当前持有者：
          <b>{{ holder ? `${holder.operator}（签出号 ${holder.id}，${holder.acquiredAt}）` : '无人持有，可签出' }}</b>
          <span class="muted" style="margin-left:8px" v-if="holder && holder.operator !== store.operator">你（{{ store.operator }}）打开为只读</span>
          <span class="muted" style="margin-left:8px" v-else-if="holder">你是当前持有者</span>
        </template>
      </n-alert>

      <!-- 签出控制 -->
      <n-space style="margin: 10px 0 4px" wrap>
        <n-button type="primary" :disabled="!!holder || !!myCo" @click="selectedCase && store.acquireCase(selectedCase.id)">
          签出该用例（{{ store.operator }}）
        </n-button>
        <n-button v-if="myCo && myCo.caseId === selectedCase?.id" @click="store.releaseCheckout(myCo.id)">提交完毕并释放签出</n-button>
        <n-select v-model:value="handoverTarget" :options="operatorOptions.filter((o) => o.value !== store.operator)" style="width: 130px" />
        <n-button v-if="myCo" type="warning" @click="store.shiftHandover(handoverTarget)">换人交班给 {{ handoverTarget }}</n-button>
      </n-space>
      <n-alert v-if="myCo && myCo.caseId !== selectedCase?.id" type="warning" style="margin: 8px 0">
        你已持有 {{ myCo.caseId }}（{{ myCo.id }}），同一时刻不能再签出别的用例。
      </n-alert>
      <n-alert v-if="caseCo && caseCo.state === '已交班'" type="info" style="margin: 8px 0">
        签出 {{ caseCo.id }} 已交班，步骤为只读；未提交内容在交班草稿中等候接续。
      </n-alert>

      <n-divider style="margin: 10px 0" />

      <div v-for="step in selectedCase?.steps" :key="step.id" style="margin-bottom: 10px">
        <StepCheckoutRow
          :case-id="selectedCase!.id"
          :step="step"
          :checkout="myCo?.caseId === selectedCase?.id ? myCo : caseCo"
          :token-current="tokenCurrent"
        />
      </div>
    </article>

    <!-- 右：交班草稿 / 发件箱 / 证据与历史 -->
    <aside class="card">
      <div class="panel-head">
        <div><h2>交班草稿</h2><p>换人后未提交步骤整体移交，确认修订/版本过期后只读</p></div>
        <n-tag>{{ store.pendingDrafts.length }} 待接续</n-tag>
      </div>
      <div v-for="d in myDrafts" :key="d.id" class="draft-card" :class="d.state">
        <div class="draft-head">
          <b>{{ d.id }} · {{ d.caseId }}</b>
          <n-tag size="small" :type="draftTagType(d.state)">{{ d.state }}</n-tag>
        </div>
        <small class="muted">{{ d.fromOperator }} → {{ d.toOperator }} · 步骤 {{ d.stepIds.join('、') }} · 原签出 {{ d.checkoutId }}</small>
        <small v-if="d.invalidReason" class="invalid-note">{{ d.invalidReason }}（仅可查看）</small>
        <n-space v-if="d.state === '待接续'" :size="8" style="margin-top: 6px">
          <n-button size="small" type="primary" @click="store.adoptDraft(d.id)">由 {{ store.operator }} 接续重开</n-button>
          <n-button size="small" @click="store.discardDraft(d.id)">放弃</n-button>
        </n-space>
      </div>
      <n-empty v-if="myDrafts.length === 0" description="暂无交班草稿" size="small" style="padding: 10px 0" />

      <n-divider />
      <div class="panel-head">
        <div><h2>写入发件箱</h2><p>按请求号恢复，重放不重复计票</p></div>
        <n-button size="tiny" @click="store.retry">全部恢复</n-button>
      </div>
      <n-radio-group v-model:value="chaosMode" size="small" @update:value="applyChaos">
        <n-radio-button value="none">正常</n-radio-button>
        <n-radio-button value="offline">断网</n-radio-button>
        <n-radio-button value="timeout">应答丢失</n-radio-button>
      </n-radio-group>
      <small class="muted" style="display:block;margin:6px 0">{{ chaosDesc }}</small>
      <div v-for="item in store.outbox" :key="item.requestId" class="outbox-item">
        <div class="draft-head"><b>{{ item.requestId }}</b><n-tag size="tiny" type="warning">{{ item.command.type }}</n-tag></div>
        <small class="muted" style="display:block">{{ item.lastError }}</small>
        <n-button size="tiny" style="margin-top:5px" @click="store.recoverOne(item.requestId)">按请求号恢复</n-button>
      </div>
      <n-empty v-if="store.outbox.length === 0" description="发件箱为空" size="small" style="padding: 8px 0" />

      <n-divider />
      <div class="panel-head"><div><h2>执行历史</h2><p>旧记录按执行历史补齐签出号来源</p></div></div>
      <n-timeline>
        <n-timeline-item
          v-for="record in store.executions" :key="record.id"
          :type="record.result === '通过' ? 'success' : record.result === '失败' ? 'error' : 'info'"
          :title="`${record.caseId} · ${record.result}`"
        >
          <div>{{ record.operator }} {{ record.startedAt }}<template v-if="record.finishedAt"> → {{ record.finishedAt }}</template> · {{ record.snapshot }}</div>
          <div class="muted">证据：{{ record.evidence.join('、') || '采集中' }}</div>
          <n-tag size="tiny" :type="record.sourceType === '历史补齐' ? 'info' : 'success'">
            {{ record.sourceType ?? '执行' }}来源：{{ record.sourceCheckoutId }}
          </n-tag>
        </n-timeline-item>
      </n-timeline>
    </aside>
  </div>
</template>
