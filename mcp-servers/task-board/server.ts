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
import { MemoryDB } from './memory'

const db = new TaskDB(DB_PATH)
const mem = new MemoryDB(db)

const mcp = new Server(
  { name: 'task-board', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${SELF_LABEL}". You have a shared task board and personal memory with other agents (boss, steve, sadie, kiera).`,
      'TASK TOOLS: create_task, claim_task, complete_task, list_tasks, send_note, nudge_agent',
      'MEMORY TOOLS: save_memory (store learnings), recall_memories (search your knowledge), get_boot_briefing (load context on startup)',
      'MEMORY MANAGEMENT: promote_memory (share with all agents), pin_memory (prevent decay)',
      'On startup, call get_boot_briefing to load your role, top memories, and recent task history.',
      'After completing tasks, save important learnings with save_memory.',
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
    {
      name: 'save_memory',
      description: 'Save a memory/learning for yourself. Persists across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'role'], description: 'Memory category' },
          importance: { type: 'number', description: 'Importance 1-5 (default: 3). Higher = persists longer.' },
          pinned: { type: 'boolean', description: 'Pin to prevent decay (default: false). Use for role definitions.' },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'recall_memories',
      description: 'Search your memories and shared team knowledge. Updates access tracking (boosts importance of accessed memories).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (matches content)' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'task_summary', 'role'], description: 'Filter by category' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
    {
      name: 'get_boot_briefing',
      description: 'Load your boot briefing: role, top memories, shared knowledge, and recent tasks. Call this on startup.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'promote_memory',
      description: 'Promote a personal memory to shared — all agents will see it.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to promote' },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'pin_memory',
      description: 'Toggle pin on a memory. Pinned memories never decay.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to pin/unpin' },
        },
        required: ['memory_id'],
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

        // Auto-extract task summary as memory
        const priorityToImportance: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 }
        mem.saveMemory({
          agent: SELF_LABEL,
          content: `Task #${task.id}: ${task.description} → Result: ${result}`,
          category: 'task_summary',
          importance: priorityToImportance[task.priority] ?? 2,
          source_task_id: task.id,
        })

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

      case 'save_memory': {
        const content = args.content as string
        const category = args.category as string
        const importance = (args.importance as number) ?? 3
        const pinned = (args.pinned as boolean) ?? false

        const memory = mem.saveMemory({
          agent: SELF_LABEL,
          content,
          category,
          importance,
          pinned,
        })

        return { content: [{ type: 'text', text: `Memory #${memory.id} saved (importance: ${memory.importance}${memory.pinned ? ', pinned' : ''})` }] }
      }

      case 'recall_memories': {
        const query = args.query as string | undefined
        const category = args.category as string | undefined
        const limit = args.limit as number | undefined

        const memories = mem.recallMemories(SELF_LABEL, { query, category, limit })

        if (memories.length === 0) {
          return { content: [{ type: 'text', text: 'No memories found.' }] }
        }

        const lines = memories.map(
          (m) => `#${m.id} [${m.category}] imp:${m.importance} ${m.pinned ? '📌' : ''} ${m.content}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'get_boot_briefing': {
        const briefing = mem.getBootBriefing(SELF_LABEL, db)
        const sections: string[] = []

        if (briefing.role.length > 0) {
          sections.push('== ROLE ==\n' + briefing.role.map(m => m.content).join('\n'))
        }
        if (briefing.topMemories.length > 0) {
          sections.push('== TOP MEMORIES ==\n' + briefing.topMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.sharedMemories.length > 0) {
          sections.push('== SHARED KNOWLEDGE ==\n' + briefing.sharedMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.recentTasks.length > 0) {
          sections.push('== RECENT TASKS ==\n' + briefing.recentTasks.map(t => `#${t.id} ${t.description} → ${t.result}`).join('\n'))
        }

        if (sections.length === 0) {
          return { content: [{ type: 'text', text: 'No memories or history yet. You are a fresh agent.' }] }
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }] }
      }

      case 'promote_memory': {
        const memoryId = args.memory_id as number
        const promoted = mem.promoteMemory(memoryId)

        if (!promoted) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        return { content: [{ type: 'text', text: `Memory #${memoryId} promoted to shared. All agents can now see it.` }] }
      }

      case 'pin_memory': {
        const memoryId = args.memory_id as number
        const toggled = mem.pinMemory(memoryId)

        if (!toggled) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        const state = toggled.pinned ? 'pinned (will not decay)' : 'unpinned (will decay normally)'
        return { content: [{ type: 'text', text: `Memory #${memoryId} ${state}.` }] }
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
