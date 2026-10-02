import { createDiscreteApi } from 'naive-ui'

// 脱离 <n-message-provider> 的全局提示，供 store / 传输层直接调用
export const { message: notify } = createDiscreteApi(['message'])
