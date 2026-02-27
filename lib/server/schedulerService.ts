import { readJsonFile, resolveDataPath, writeJsonFileAtomic } from '@/lib/server/fsStore'
import { executeAgent } from '@/lib/server/agentRuntime'
import { DEFAULT_RAG_ID } from '@/lib/config/env'

export type Schedule = {
  id: string
  user_id: string
  agent_id: string
  message: string
  cron_expression: string
  timezone: string
  max_retries: number
  retry_delay: number
  is_active: boolean
  created_at: string
  updated_at: string
  next_run_time: string | null
  last_run_at: string | null
  last_run_success: boolean | null
}

export type ExecutionLog = {
  id: string
  schedule_id: string
  agent_id: string
  user_id: string
  session_id: string
  executed_at: string
  attempt: number
  max_attempts: number
  success: boolean
  payload_message: string
  response_status: number
  response_output: string
  error_message: string | null
}

type SchedulerStore = {
  schedules: Schedule[]
  executions: ExecutionLog[]
}

const SCHEDULER_STORE_PATH = resolveDataPath('scheduler', 'store.json')

const globalScheduler = globalThis as typeof globalThis & {
  __researchTwinSchedulerStarted?: boolean
  __researchTwinSchedulerTick?: NodeJS.Timeout
  __researchTwinSchedulerLock?: boolean
}

async function readStore(): Promise<SchedulerStore> {
  return readJsonFile<SchedulerStore>(SCHEDULER_STORE_PATH, {
    schedules: [],
    executions: [],
  })
}

async function writeStore(store: SchedulerStore): Promise<void> {
  await writeJsonFileAtomic(SCHEDULER_STORE_PATH, store)
}

function parseField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true

  return field.split(',').some(part => {
    if (part.includes('/')) {
      const [base, stepRaw] = part.split('/')
      const step = Number.parseInt(stepRaw || '1', 10)
      if (!step || step < 1) return false

      if (base === '*') {
        return value % step === 0
      }

      if (base.includes('-')) {
        const [startRaw, endRaw] = base.split('-')
        const start = Number.parseInt(startRaw || `${min}`, 10)
        const end = Number.parseInt(endRaw || `${max}`, 10)
        if (value < start || value > end) return false
        return (value - start) % step === 0
      }

      const baseValue = Number.parseInt(base, 10)
      if (!Number.isFinite(baseValue)) return false
      if (value < baseValue) return false
      return (value - baseValue) % step === 0
    }

    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-')
      const start = Number.parseInt(startRaw || `${min}`, 10)
      const end = Number.parseInt(endRaw || `${max}`, 10)
      return value >= start && value <= end
    }

    const exact = Number.parseInt(part, 10)
    return Number.isFinite(exact) && value === exact
  })
}

function matchesCron(cronExpression: string, date: Date): boolean {
  const parts = cronExpression.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekExpr] = parts

  const minute = date.getUTCMinutes()
  const hour = date.getUTCHours()
  const day = date.getUTCDate()
  const month = date.getUTCMonth() + 1
  const week = date.getUTCDay()

  return (
    parseField(minuteExpr, minute, 0, 59)
    && parseField(hourExpr, hour, 0, 23)
    && parseField(dayExpr, day, 1, 31)
    && parseField(monthExpr, month, 1, 12)
    && parseField(weekExpr, week, 0, 6)
  )
}

function asMinuteKey(isoString: string | null): string | null {
  if (!isoString) return null
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`
}

function isDue(schedule: Schedule, now: Date): boolean {
  if (!schedule.is_active) return false
  if (!matchesCron(schedule.cron_expression, now)) return false

  const lastMinute = asMinuteKey(schedule.last_run_at)
  const nowMinute = asMinuteKey(now.toISOString())
  return lastMinute !== nowMinute
}

function computeNextRun(cronExpression: string, startDate?: Date): string | null {
  const start = startDate || new Date()
  const cursor = new Date(start)
  cursor.setUTCSeconds(0, 0)

  for (let i = 0; i < 60 * 24 * 30; i++) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
    if (matchesCron(cronExpression, cursor)) {
      return cursor.toISOString()
    }
  }

  return null
}

async function logExecution(store: SchedulerStore, log: ExecutionLog): Promise<void> {
  store.executions.unshift(log)
  if (store.executions.length > 1000) {
    store.executions = store.executions.slice(0, 1000)
  }
}

async function executeScheduleInternal(schedule: Schedule): Promise<{ success: boolean; output: string; error: string | null }> {
  const maxAttempts = Math.max(1, (schedule.max_retries ?? 0) + 1)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sessionId = `schedule-${schedule.id}-${Date.now()}`
      const response = await executeAgent({
        message: schedule.message,
        agent_id: schedule.agent_id,
        user_id: schedule.user_id,
        session_id: sessionId,
        rag_id: DEFAULT_RAG_ID,
      })

      return {
        success: true,
        output: response.result.response_text,
        error: null,
      }
    } catch (error) {
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.max(100, schedule.retry_delay) * 1000))
        continue
      }

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown scheduler execution error',
      }
    }
  }

  return {
    success: false,
    output: '',
    error: 'Unknown scheduler failure',
  }
}

async function processDueSchedules(): Promise<void> {
  if (globalScheduler.__researchTwinSchedulerLock) {
    return
  }

  globalScheduler.__researchTwinSchedulerLock = true
  try {
    const store = await readStore()
    const now = new Date()

    for (const schedule of store.schedules) {
      if (!isDue(schedule, now)) {
        continue
      }

      const result = await executeScheduleInternal(schedule)

      schedule.last_run_at = now.toISOString()
      schedule.last_run_success = result.success
      schedule.updated_at = now.toISOString()
      schedule.next_run_time = computeNextRun(schedule.cron_expression, now)

      await logExecution(store, {
        id: crypto.randomUUID(),
        schedule_id: schedule.id,
        agent_id: schedule.agent_id,
        user_id: schedule.user_id,
        session_id: `schedule-${schedule.id}-${Date.now()}`,
        executed_at: now.toISOString(),
        attempt: 1,
        max_attempts: Math.max(1, (schedule.max_retries ?? 0) + 1),
        success: result.success,
        payload_message: schedule.message,
        response_status: result.success ? 200 : 500,
        response_output: result.output,
        error_message: result.error,
      })
    }

    await writeStore(store)
  } finally {
    globalScheduler.__researchTwinSchedulerLock = false
  }
}

export function initializeSchedulerEngine(): void {
  if (globalScheduler.__researchTwinSchedulerStarted) {
    return
  }

  globalScheduler.__researchTwinSchedulerStarted = true
  globalScheduler.__researchTwinSchedulerTick = setInterval(() => {
    void processDueSchedules()
  }, 30_000)
}

export async function listSchedules(params?: {
  agentId?: string
  is_active?: boolean
  skip?: number
  limit?: number
}): Promise<{ schedules: Schedule[]; total: number }> {
  const store = await readStore()

  let schedules = [...store.schedules]
  if (params?.agentId) {
    schedules = schedules.filter(schedule => schedule.agent_id === params.agentId)
  }
  if (params?.is_active !== undefined) {
    schedules = schedules.filter(schedule => schedule.is_active === params.is_active)
  }

  const total = schedules.length
  const skip = params?.skip ?? 0
  const limit = params?.limit ?? total

  return {
    schedules: schedules.slice(skip, skip + limit),
    total,
  }
}

export async function getSchedule(scheduleId: string): Promise<Schedule | null> {
  const store = await readStore()
  return store.schedules.find(schedule => schedule.id === scheduleId) || null
}

export async function getSchedulesForAgent(agentId: string): Promise<{ agent_id: string; schedules: Schedule[]; webhooks: [] }> {
  const store = await readStore()
  return {
    agent_id: agentId,
    schedules: store.schedules.filter(schedule => schedule.agent_id === agentId),
    webhooks: [],
  }
}

export async function getScheduleLogs(scheduleId: string, params?: {
  skip?: number
  limit?: number
}): Promise<{ executions: ExecutionLog[]; total: number }> {
  const store = await readStore()
  const logs = store.executions.filter(execution => execution.schedule_id === scheduleId)
  const total = logs.length
  const skip = params?.skip ?? 0
  const limit = params?.limit ?? total

  return {
    executions: logs.slice(skip, skip + limit),
    total,
  }
}

export async function getRecentExecutions(params?: {
  agentId?: string
  success?: boolean
  hours?: number
  days?: number
  skip?: number
  limit?: number
}): Promise<{ executions: ExecutionLog[]; total: number }> {
  const store = await readStore()

  let executions = [...store.executions]

  if (params?.agentId) {
    executions = executions.filter(execution => execution.agent_id === params.agentId)
  }

  if (params?.success !== undefined) {
    executions = executions.filter(execution => execution.success === params.success)
  }

  if (params?.hours || params?.days) {
    const threshold = new Date()
    if (params?.hours) {
      threshold.setHours(threshold.getHours() - params.hours)
    }
    if (params?.days) {
      threshold.setDate(threshold.getDate() - params.days)
    }

    executions = executions.filter(execution => new Date(execution.executed_at) >= threshold)
  }

  const total = executions.length
  const skip = params?.skip ?? 0
  const limit = params?.limit ?? total

  return {
    executions: executions.slice(skip, skip + limit),
    total,
  }
}

export async function createSchedule(params: {
  agent_id: string
  cron_expression: string
  message: string
  timezone?: string
  max_retries?: number
  retry_delay?: number
  user_id?: string
}): Promise<Schedule> {
  const now = new Date().toISOString()
  const schedule: Schedule = {
    id: crypto.randomUUID(),
    user_id: params.user_id || 'local-user',
    agent_id: params.agent_id,
    message: params.message,
    cron_expression: params.cron_expression,
    timezone: params.timezone || 'UTC',
    max_retries: params.max_retries ?? 1,
    retry_delay: params.retry_delay ?? 30,
    is_active: true,
    created_at: now,
    updated_at: now,
    next_run_time: computeNextRun(params.cron_expression),
    last_run_at: null,
    last_run_success: null,
  }

  const store = await readStore()
  store.schedules.push(schedule)
  await writeStore(store)

  return schedule
}

export async function pauseSchedule(scheduleId: string): Promise<Schedule | null> {
  const store = await readStore()
  const schedule = store.schedules.find(item => item.id === scheduleId)
  if (!schedule) return null

  schedule.is_active = false
  schedule.updated_at = new Date().toISOString()
  schedule.next_run_time = null
  await writeStore(store)
  return schedule
}

export async function resumeSchedule(scheduleId: string): Promise<Schedule | null> {
  const store = await readStore()
  const schedule = store.schedules.find(item => item.id === scheduleId)
  if (!schedule) return null

  schedule.is_active = true
  schedule.updated_at = new Date().toISOString()
  schedule.next_run_time = computeNextRun(schedule.cron_expression)
  await writeStore(store)
  return schedule
}

export async function triggerSchedule(scheduleId: string): Promise<boolean> {
  const store = await readStore()
  const schedule = store.schedules.find(item => item.id === scheduleId)
  if (!schedule) return false

  const result = await executeScheduleInternal(schedule)
  const nowIso = new Date().toISOString()

  schedule.last_run_at = nowIso
  schedule.last_run_success = result.success
  schedule.updated_at = nowIso
  schedule.next_run_time = computeNextRun(schedule.cron_expression)

  await logExecution(store, {
    id: crypto.randomUUID(),
    schedule_id: schedule.id,
    agent_id: schedule.agent_id,
    user_id: schedule.user_id,
    session_id: `manual-${schedule.id}-${Date.now()}`,
    executed_at: nowIso,
    attempt: 1,
    max_attempts: Math.max(1, (schedule.max_retries ?? 0) + 1),
    success: result.success,
    payload_message: schedule.message,
    response_status: result.success ? 200 : 500,
    response_output: result.output,
    error_message: result.error,
  })

  await writeStore(store)
  return true
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  const store = await readStore()
  const initialLength = store.schedules.length
  store.schedules = store.schedules.filter(schedule => schedule.id !== scheduleId)

  if (store.schedules.length === initialLength) {
    return false
  }

  await writeStore(store)
  return true
}
