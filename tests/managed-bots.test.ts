import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { TaskDB } from '../db'
import { ManagedBotsDB, getManagedBotToken, replaceManagedBotToken, createManagedBotLink, initiateCreation, recoverBotToken } from '../managed-bots'
import { unlinkSync } from 'fs'

const TEST_DB = '/tmp/managed-bots-test.db'

describe('ManagedBotsDB', () => {
  let taskDb: TaskDB
  let botsDb: ManagedBotsDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    botsDb = new ManagedBotsDB(taskDb)
  })

  test('insert creates a pending bot record', () => {
    const bot = botsDb.insert({ intended_username: 'test_helper_bot' })
    expect(bot.id).toBeGreaterThan(0)
    expect(bot.intended_username).toBe('test_helper_bot')
    expect(bot.status).toBe('pending')
    expect(bot.token).toBeNull()
    expect(bot.bot_id).toBeNull()
    expect(bot.created_at).toBeTruthy()
  })

  test('insert with display_name', () => {
    const bot = botsDb.insert({ intended_username: 'test_bot', display_name: 'Test Bot' })
    expect(bot.display_name).toBe('Test Bot')
  })

  test('markCreated updates token, bot_id, and status', () => {
    const bot = botsDb.insert({ intended_username: 'test_bot' })
    const created = botsDb.markCreated(bot.id, 'fake:token123', 99999)
    expect(created.status).toBe('created')
    expect(created.token).toBe('fake:token123')
    expect(created.bot_id).toBe(99999)
  })

  test('markFailed appends to error_log', () => {
    const bot = botsDb.insert({ intended_username: 'test_bot' })
    const failed1 = botsDb.markFailed(bot.id, 'first error')
    expect(failed1.status).toBe('failed')
    expect(failed1.error_log).toContain('first error')

    const failed2 = botsDb.markFailed(bot.id, 'second error')
    expect(failed2.error_log).toContain('first error')
    expect(failed2.error_log).toContain('second error')
  })

  test('markRecovered updates token and sets recovered_at', () => {
    const bot = botsDb.insert({ intended_username: 'test_bot' })
    botsDb.markFailed(bot.id, 'lost token')
    const recovered = botsDb.markRecovered(bot.id, 'recovered:token456')
    expect(recovered.status).toBe('recovered')
    expect(recovered.token).toBe('recovered:token456')
    expect(recovered.recovered_at).toBeTruthy()
  })

  test('getByUsername returns the bot', () => {
    botsDb.insert({ intended_username: 'lookup_bot' })
    const found = botsDb.getByUsername('lookup_bot')
    expect(found).not.toBeNull()
    expect(found!.intended_username).toBe('lookup_bot')
  })

  test('getByUsername returns null for missing', () => {
    const found = botsDb.getByUsername('nonexistent_bot')
    expect(found).toBeNull()
  })

  test('getByBotId returns the bot', () => {
    const bot = botsDb.insert({ intended_username: 'id_bot' })
    botsDb.markCreated(bot.id, 'tok', 12345)
    const found = botsDb.getByBotId(12345)
    expect(found).not.toBeNull()
    expect(found!.bot_id).toBe(12345)
  })

  test('getByBotId returns null for missing', () => {
    expect(botsDb.getByBotId(99999)).toBeNull()
  })

  test('getById returns the bot', () => {
    const bot = botsDb.insert({ intended_username: 'byid_bot' })
    const found = botsDb.getById(bot.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(bot.id)
  })

  test('listAll returns all bots', () => {
    botsDb.insert({ intended_username: 'bot_a' })
    botsDb.insert({ intended_username: 'bot_b' })
    const all = botsDb.listAll()
    expect(all.length).toBe(2)
  })

  test('listByStatus filters correctly', () => {
    const bot1 = botsDb.insert({ intended_username: 'pending_bot' })
    const bot2 = botsDb.insert({ intended_username: 'created_bot' })
    botsDb.markCreated(bot2.id, 'tok', 111)

    expect(botsDb.listByStatus('pending').length).toBe(1)
    expect(botsDb.listByStatus('created').length).toBe(1)
    expect(botsDb.listByStatus('failed').length).toBe(0)
  })
})

describe('Bot API client', () => {
  test('createManagedBotLink returns correct URL', () => {
    const link = createManagedBotLink('my_new_bot')
    expect(link).toBe('https://t.me/newbot/taskrunner1bot/my_new_bot')
  })

  test('createManagedBotLink with custom manager', () => {
    const link = createManagedBotLink('my_bot', 'other_manager')
    expect(link).toBe('https://t.me/newbot/other_manager/my_bot')
  })
})

describe('initiateCreation', () => {
  let taskDb: TaskDB
  let botsDb: ManagedBotsDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    botsDb = new ManagedBotsDB(taskDb)
  })

  test('creates DB record and returns link', () => {
    const { record, link } = initiateCreation(botsDb, { intended_username: 'new_bot' })
    expect(record.status).toBe('pending')
    expect(record.intended_username).toBe('new_bot')
    expect(link).toContain('t.me/newbot/taskrunner1bot/new_bot')

    // Verify it's in the DB
    const found = botsDb.getByUsername('new_bot')
    expect(found).not.toBeNull()
  })
})
