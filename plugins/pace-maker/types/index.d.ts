// The $.state contract. A contract file must be self-contained, so these shapes repeat the ones in
// hooks/lib/{progress,state,background}.ts; the type-check of register.tsx fails if they drift apart.
declare module 'claude-code' {
  interface PluginState {
    'pace-maker': {
      progress: Shaped<{
        shape: 'progress-1'
        tasks: {
          id: string
          subject: string
          activeForm?: string
          status: 'pending' | 'in_progress' | 'completed' | 'deleted'
          blockedBy: string[]
        }[]
        source: 'task' | 'todo' | 'plan' | null
        held: {
          taskId: string
          status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
          subject?: string
          activeForm?: string
          addBlockedBy?: string[]
        }[]
      }>
      session: Shaped<{
        shape: 'state-2'
        disabled: boolean
        running: boolean
        startedAt: number | null
        endedAt: number | null
        permission: { tool: string } | null
        pause: { reason: string } | null
        planWaiting: boolean
        error: { code?: string; message: string } | null
        denied: { tool: string } | null
        limit: { resetsAt?: string } | null
        lastEnd: { isAborted: boolean; answer: string } | null
        stopReason: string | null
      }>
      bg: Shaped<{
        shape: 'bg-1'
        items: { id: string; kind: 'shell' | 'agent' | 'monitor'; label: string }[]
      }>
    }
  }
}
