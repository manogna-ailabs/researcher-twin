import { NextRequest, NextResponse } from 'next/server'
import { ensureDataDirs } from '@/lib/server/fsStore'
import { enforceApiSecurity } from '@/lib/server/security'
import {
  createSchedule,
  deleteSchedule,
  getRecentExecutions,
  getSchedule,
  getScheduleLogs,
  getSchedulesForAgent,
  initializeSchedulerEngine,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
} from '@/lib/server/schedulerService'

export const runtime = 'nodejs'

initializeSchedulerEngine()

function securityGuard(request: NextRequest): NextResponse | null {
  return enforceApiSecurity(request, {
    routeId: 'scheduler',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_SCHEDULER_MAX || '90', 10),
  })
}

// GET — list | get | by-agent | logs | recent
export async function GET(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action') || 'list'
    const scheduleId = searchParams.get('scheduleId')
    const agentId = searchParams.get('agentId')

    switch (action) {
      case 'get': {
        if (!scheduleId) {
          return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
        }

        const schedule = await getSchedule(scheduleId)
        if (!schedule) {
          return NextResponse.json({ success: false, error: 'Schedule not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, ...schedule })
      }

      case 'by-agent': {
        if (!agentId) {
          return NextResponse.json({ success: false, error: 'agentId is required' }, { status: 400 })
        }

        const data = await getSchedulesForAgent(agentId)
        return NextResponse.json({ success: true, ...data })
      }

      case 'logs': {
        if (!scheduleId) {
          return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
        }

        const skip = Number.parseInt(searchParams.get('skip') || '0', 10)
        const limit = Number.parseInt(searchParams.get('limit') || '20', 10)
        const data = await getScheduleLogs(scheduleId, { skip, limit })
        return NextResponse.json({ success: true, ...data })
      }

      case 'recent': {
        const skip = Number.parseInt(searchParams.get('skip') || '0', 10)
        const limit = Number.parseInt(searchParams.get('limit') || '20', 10)
        const success = searchParams.get('success')
        const hours = searchParams.get('hours')
        const days = searchParams.get('days')

        const data = await getRecentExecutions({
          agentId: agentId || undefined,
          success: success === null ? undefined : success === 'true',
          hours: hours ? Number.parseInt(hours, 10) : undefined,
          days: days ? Number.parseInt(days, 10) : undefined,
          skip,
          limit,
        })

        return NextResponse.json({ success: true, ...data })
      }

      case 'list':
      default: {
        const skip = Number.parseInt(searchParams.get('skip') || '0', 10)
        const limit = Number.parseInt(searchParams.get('limit') || '50', 10)
        const isActive = searchParams.get('is_active')

        const data = await listSchedules({
          agentId: agentId || undefined,
          is_active: isActive === null ? undefined : isActive === 'true',
          skip,
          limit,
        })

        return NextResponse.json({ success: true, ...data })
      }
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Server error' },
      { status: 500 }
    )
  }
}

// POST — create | pause | resume | trigger
export async function POST(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const body = await request.json()
    const { action, scheduleId, ...params } = body

    switch (action) {
      case 'trigger': {
        if (!scheduleId) {
          return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
        }

        const triggered = await triggerSchedule(scheduleId)
        if (!triggered) {
          return NextResponse.json({ success: false, error: 'Schedule not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, message: 'Schedule triggered successfully' }, { status: 202 })
      }

      case 'pause': {
        if (!scheduleId) {
          return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
        }

        const schedule = await pauseSchedule(scheduleId)
        if (!schedule) {
          return NextResponse.json({ success: false, error: 'Schedule not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, ...schedule })
      }

      case 'resume': {
        if (!scheduleId) {
          return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
        }

        const schedule = await resumeSchedule(scheduleId)
        if (!schedule) {
          return NextResponse.json({ success: false, error: 'Schedule not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, ...schedule })
      }

      case 'create':
      default: {
        if (!params.agent_id || !params.cron_expression || !params.message) {
          return NextResponse.json(
            { success: false, error: 'agent_id, cron_expression, and message are required' },
            { status: 400 }
          )
        }

        const schedule = await createSchedule({
          agent_id: String(params.agent_id),
          cron_expression: String(params.cron_expression),
          message: String(params.message),
          timezone: params.timezone ? String(params.timezone) : 'UTC',
          max_retries: params.max_retries ? Number(params.max_retries) : 1,
          retry_delay: params.retry_delay ? Number(params.retry_delay) : 30,
          user_id: process.env.DEFAULT_USER_ID || 'local-user',
        })

        return NextResponse.json({ success: true, ...schedule }, { status: 201 })
      }
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Server error' },
      { status: 500 }
    )
  }
}

// DELETE — delete schedule
export async function DELETE(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const body = await request.json()
    const { scheduleId } = body

    if (!scheduleId) {
      return NextResponse.json({ success: false, error: 'scheduleId is required' }, { status: 400 })
    }

    const deleted = await deleteSchedule(String(scheduleId))
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Schedule not found' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      message: 'Schedule deleted successfully',
      scheduleId,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Server error' },
      { status: 500 }
    )
  }
}
