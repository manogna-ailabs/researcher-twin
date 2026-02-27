import { NextRequest, NextResponse } from 'next/server'
/**
 * Agent API route.
 * Responsibilities:
 * - Submit async agent tasks.
 * - Poll task status/results.
 * - Keep in-memory task lifecycle isolated from client polling flow.
 */
import { DEFAULT_AGENT_TASK_TTL_MS, DEFAULT_RATE_LIMIT_WINDOW_MS } from '@/lib/config/env'
import { executeAgent } from '@/lib/server/agentRuntime'
import { ensureDataDirs } from '@/lib/server/fsStore'
import { enforceApiSecurity } from '@/lib/server/security'

export const runtime = 'nodejs'

type TaskState = {
  status: 'processing' | 'completed' | 'failed'
  createdAt: number
  response?: {
    status: 'success' | 'error'
    result: Record<string, any>
    message?: string
    metadata?: Record<string, any>
  }
  error?: string
}

const globalTaskState = globalThis as typeof globalThis & {
  __researchTwinAgentTasks?: Map<string, TaskState>
}

const taskStore = globalTaskState.__researchTwinAgentTasks ?? new Map<string, TaskState>()
if (!globalTaskState.__researchTwinAgentTasks) {
  globalTaskState.__researchTwinAgentTasks = taskStore
}

const TASK_TTL_MS = DEFAULT_AGENT_TASK_TTL_MS

function purgeExpiredTasks() {
  const now = Date.now()
  for (const [taskId, task] of taskStore.entries()) {
    if (now - task.createdAt > TASK_TTL_MS) {
      taskStore.delete(taskId)
    }
  }
}

async function submitTask(body: any) {
  const { message, agent_id, user_id, session_id, assets, rag_id } = body

  if (!message || !agent_id) {
    return NextResponse.json(
      {
        success: false,
        response: { status: 'error', result: {}, message: 'message and agent_id are required' },
        error: 'message and agent_id are required',
      },
      { status: 400 }
    )
  }

  const finalUserId = user_id || `user-${crypto.randomUUID()}`
  const finalSessionId = session_id || `${agent_id}-${crypto.randomUUID().slice(0, 12)}`
  const taskId = crypto.randomUUID()

  taskStore.set(taskId, {
    status: 'processing',
    createdAt: Date.now(),
  })

  void (async () => {
    try {
      const result = await executeAgent({
        message,
        agent_id,
        user_id: finalUserId,
        session_id: finalSessionId,
        assets: Array.isArray(assets) ? assets : [],
        rag_id,
      })

      taskStore.set(taskId, {
        status: 'completed',
        createdAt: Date.now(),
        response: result,
      })
    } catch (error) {
      taskStore.set(taskId, {
        status: 'failed',
        createdAt: Date.now(),
        error: error instanceof Error ? error.message : 'Agent task failed',
      })
    }
  })()

  return NextResponse.json({
    task_id: taskId,
    agent_id,
    user_id: finalUserId,
    session_id: finalSessionId,
  })
}

function pollTask(taskId: string) {
  purgeExpiredTasks()

  const task = taskStore.get(taskId)
  if (!task) {
    return NextResponse.json(
      {
        success: false,
        status: 'failed',
        error: 'Task expired or not found',
      },
      { status: 404 }
    )
  }

  if (task.status === 'processing') {
    return NextResponse.json({ status: 'processing' })
  }

  if (task.status === 'failed') {
    taskStore.delete(taskId)
    return NextResponse.json(
      {
        success: false,
        status: 'failed',
        response: { status: 'error', result: {}, message: task.error || 'Agent task failed' },
        error: task.error || 'Agent task failed',
      },
      { status: 500 }
    )
  }

  taskStore.delete(taskId)
  return NextResponse.json({
    success: true,
    status: 'completed',
    response: task.response,
    timestamp: new Date().toISOString(),
    raw_response: JSON.stringify(task.response),
  })
}

/**
 * POST /api/agent
 * Submit mode: { message, agent_id, ... }
 * Poll mode: { task_id }
 */
export async function POST(request: NextRequest) {
  const securityError = enforceApiSecurity(request, {
    routeId: 'agent',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_AGENT_MAX || '240', 10),
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  })
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const body = await request.json()
    if (body.task_id) {
      return pollTask(String(body.task_id))
    }

    return await submitTask(body)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json(
      {
        success: false,
        response: { status: 'error', result: {}, message: errorMsg },
        error: errorMsg,
      },
      { status: 500 }
    )
  }
}
