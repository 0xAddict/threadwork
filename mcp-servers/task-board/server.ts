#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TaskDB } from './db'
import { nudgeAgent } from './nudge'
import {
  postToGroup,
  formatTaskCreated,
  formatTaskClaimed,
  formatTaskCompleted,
  formatNote,
} from './notify'
import { DB_PATH, SELF_LABEL } from './config'

const db = new TaskDB(DB_PATH)

const mcp = new Server(
  { name: 'task-board', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${SELF_LABEL}". You have a shared task board with other agents (boss, steve, sadie, kiera).`,
      'Use create_task to assign work to another agent. It auto-nudges them and posts to the team group.',
      'Use list_tasks to check your inbox (filter: "mine") or see all work.',
      'Use claim_task when you start working on a task assigned to you.',
      'Use complete_task when done — include a result summary.',
      'Use send_note to add context to any task.',
      'Use nudge_agent to wake an agent without creating a task.',
      'Always delegate complex work to subagents (Agent tool) to keep your context clean.',
    ].join('\n'),
  },
)

// Register tool list
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_task',
      description: 'Create a task and assign it to another agent. Auto-nudges the target agent and posts to the team Telegram group.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          description: { type: 'string', description: 'What needs to be done' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority (default: normal)' },
        },
        required: ['to', 'description'],
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a pending task assigned to you. Sets status to in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to claim' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task as completed with a result summary. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to complete' },
          result: { type: 'string', description: 'Summary of what was done' },
        },
        required: ['task_id', 'result'],
      },
    },
    {
      name: 'list_tasks',
      description: 'List tasks. Filter by assignee and/or status.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['mine', 'pending', 'in_progress', 'completed', 'all'],
            description: '"mine" shows tasks assigned to you. Others filter by status. Default: mine.',
          },
        },
      },
    },
    {
      name: 'send_note',
      description: 'Add a note/comment to a task. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID' },
          message: { type: 'string', description: 'The note content' },
        },
        required: ['task_id', 'message'],
      },
    },
    {
      name: 'nudge_agent',
      description: 'Send a wake message to another agent without creating a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent', 'message'],
      },
    },
  ],
}))

// Handle tool calls
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'create_task': {
        const to = (args.to as string).toLowerCase()
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'

        const task = db.createTask({ from: SELF_LABEL, to, description, priority })

        const nudgeMsg = `You have a new task (#${task.id}) from ${SELF_LABEL}: ${description}`
        await nudgeAgent(to, nudgeMsg)
        await postToGroup(formatTaskCreated(task))

        return { content: [{ type: 'text', text: `Task #${task.id} created and assigned to ${to}. Agent nudged.` }] }
      }

      case 'claim_task': {
        const taskId = args.task_id as number
        const task = db.claimTask(taskId, SELF_LABEL)

        if (!task) {
          return { content: [{ type: 'text', text: `Cannot claim task #${taskId} — either it doesn't exist or is already claimed.`, isError: true }] }
        }

        await postToGroup(formatTaskClaimed(task))
        return { content: [{ type: 'text', text: `Claimed task #${task.id}: ${task.description}` }] }
      }

      case 'complete_task': {
        const taskId = args.task_id as number
        const result = args.result as string
        const task = db.completeTask(taskId, result)

        if (!task) {
          return { content: [{ type: 'text', text: `Cannot complete task #${taskId} — either it doesn't exist or isn't in progress.`, isError: true }] }
        }

        const nudgeMsg = `Task #${task.id} completed by ${SELF_LABEL}: ${result}`
        await nudgeAgent(task.from_agent, nudgeMsg)
        await postToGroup(formatTaskCompleted(task))

        return { content: [{ type: 'text', text: `Task #${task.id} completed. Result: ${result}` }] }
      }

      case 'list_tasks': {
        const filterStr = (args.filter as string) ?? 'mine'
        let filter: { assignee?: string; status?: string } = {}

        if (filterStr === 'mine') {
          filter.assignee = SELF_LABEL
        } else if (filterStr !== 'all') {
          filter.status = filterStr
        }

        const tasks = db.listTasks(filter)

        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: 'No tasks found.' }] }
        }

        const lines = tasks.map(
          (t) => `#${t.id} [${t.status}] ${t.from_agent}→${t.to_agent}: ${t.description}${t.result ? ` | Result: ${t.result}` : ''}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'send_note': {
        const taskId = args.task_id as number
        const message = args.message as string

        const task = db.getTask(taskId)
        if (!task) {
          return { content: [{ type: 'text', text: `Task #${taskId} not found.`, isError: true }] }
        }

        db.addNote(taskId, SELF_LABEL, message)
        await postToGroup(formatNote(taskId, SELF_LABEL, message))

        return { content: [{ type: 'text', text: `Note added to task #${taskId}.` }] }
      }

      case 'nudge_agent': {
        const agent = (args.agent as string).toLowerCase()
        const message = args.message as string
        const result = await nudgeAgent(agent, message)

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Nudge failed: ${result.error}`, isError: true }] }
        }

        return { content: [{ type: 'text', text: `Nudged ${agent}: ${message}` }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}`, isError: true }] }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}`, isError: true }] }
  }
})

await mcp.connect(new StdioServerTransport())

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
