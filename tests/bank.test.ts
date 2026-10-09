import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Lesson, Trial } from '../types'
import {
  addLesson,
  MAX_LESSONS,
  nextArm,
  NO_TRIAL,
  NO_TURN,
  parseLesson,
  parseTyped,
  recall,
  recordCheck,
  recordTurn,
  verdictOf,
  wordsOf,
} from '../hooks/bank'

const ROOT = '/repo'

const lesson = (when: string, action: string, tags: string[], uses = 0, at = 1): Lesson => ({
  id: `${at}-${when}`,
  at,
  when,
  do: action,
  tags,
  uses,
  source: 'learned',
})

const MIGRATE = lesson(
  'a database migration fails on a locked table',
  'run migrations with --lock-timeout and retry once',
  ['migration', 'database', 'postgres', 'lock'],
)
const FIXTURE = lesson(
  'pytest fixtures leak state between tests',
  'scope the fixture to function and reset the cache in teardown',
  ['pytest', 'fixture', 'flaky', 'tests'],
)

describe('recall', () => {
  test('a prompt recalls the lesson it shares words with, and not the other', () => {
    expect(recall([MIGRATE, FIXTURE], 'add a database migration for the orders table')).toEqual([MIGRATE])
    expect(recall([MIGRATE, FIXTURE], 'the pytest fixtures are flaky again')).toEqual([FIXTURE])
  })

  test('one word in common is a coincidence, not a match', () => {
    expect(recall([MIGRATE, FIXTURE], 'rename the database variable')).toEqual([])
    expect(recall([MIGRATE, FIXTURE], 'write the release notes')).toEqual([])
  })

  test('plurals and endings do not hide a match', () => {
    expect(wordsOf('Migrations failed while testing fixtures')).toEqual(['migration', 'fail', 'while', 'test', 'fixture'])
    expect(recall([MIGRATE], 'the migrations keep locking the database')).toEqual([MIGRATE])
  })

  test('at most three come back, the best fit first', () => {
    const many = [1, 2, 3, 4, 5].map(n => lesson(`database migration case ${n}`, 'x', ['migration', 'database'], n, n))
    const got = recall(many, 'database migration')

    expect(got).toHaveLength(3)
    expect(got.map(one => one.uses)).toEqual([5, 4, 3])
  })
})

describe('learning', () => {
  test('a reply is read whether or not the model wrapped it in prose', () => {
    const reply =
      'Here it is: {"when": "When the eval hangs on CI", "do": "set --workers 1", "tags": ["Eval", "ci", "hang", "ci"]}'

    expect(parseLesson(reply)).toEqual({ when: 'the eval hangs on CI', do: 'set --workers 1', tags: ['eval', 'ci', 'hang'] })
  })

  test('a skip, a broken reply or a lesson with no tags saves nothing', () => {
    expect(parseLesson('{"skip": true}')).toBe(null)
    expect(parseLesson('I could not find one.')).toBe(null)
    expect(parseLesson('{"when": "x happens", "do": "y", "tags": []}')).toBe(null)
    expect(parseLesson('{"when": "x happens", "do": ')).toBe(null)
  })

  test('a typed lesson takes its tags from its own words', () => {
    expect(parseTyped('the tests hang => run them with -x first')).toEqual({
      when: 'the tests hang',
      do: 'run them with -x first',
      tags: ['test', 'hang'],
    })
    expect(parseTyped('no arrow here')).toBe(null)
  })

  test('the same lesson is not banked twice', () => {
    const once = addLesson([], MIGRATE, 5, 'learned')
    const twice = addLesson(once, { ...MIGRATE, when: 'A database migration FAILS on a locked table' }, 6, 'learned')

    expect(twice).toHaveLength(1)
  })

  test('a full bank gives up its least used, oldest lesson', () => {
    let all: Lesson[] = []

    for (let n = 0; n < MAX_LESSONS; n += 1) all = addLesson(all, { when: `case ${n} happens`, do: `do ${n}`, tags: ['x'] }, n, 'learned')

    all = all.map((one, index) => (index === 0 ? one : { ...one, uses: 1 }))

    const after = addLesson(all, { when: 'a new case', do: 'a new thing', tags: ['new'] }, 999, 'learned')

    expect(after).toHaveLength(MAX_LESSONS)
    expect(after.some(one => one.when === 'case 0 happens')).toBe(false)
    expect(after.at(-1)?.when).toBe('a new case')
  })

  test('a pass after a failure marks the turn; a pass alone does not', () => {
    expect(recordCheck(recordCheck(NO_TURN, false), true).hasRecovered).toBe(true)
    expect(recordCheck(recordCheck(NO_TURN, true), true).hasRecovered).toBe(false)
    expect(recordCheck(recordCheck(NO_TURN, true), false).hasRecovered).toBe(false)
  })
})

describe('the trial', () => {
  const arms = (withArm: [number, number], withoutArm: [number, number]): Trial => ({
    with: { turns: withArm[0], checks: withArm[0] * 2, failures: withArm[1] },
    without: { turns: withoutArm[0], checks: withoutArm[0] * 2, failures: withoutArm[1] },
  })

  test('the arms alternate, so they stay the same size', () => {
    let trial = NO_TRIAL
    const seen: string[] = []

    for (let n = 0; n < 6; n += 1) {
      const arm = nextArm(trial)

      seen.push(arm)
      trial = recordTurn(trial, { ...NO_TURN, arm, checks: 1, failures: 0 })
    }

    expect(seen).toEqual(['with', 'without', 'with', 'without', 'with', 'without'])
    expect(trial.with.turns).toBe(3)
  })

  test('it says nothing until both arms have thirty turns', () => {
    expect(verdictOf(arms([29, 0], [40, 40]))).toEqual({
      tone: null,
      text: 'Not enough turns yet: 29 of 30 in the smaller arm.',
    })
  })

  test('a fifth fewer failures counts as helping; less than that does not', () => {
    expect(verdictOf(arms([30, 12], [30, 15])).tone).toBe('success')
    expect(verdictOf(arms([30, 13], [30, 15])).tone).toBe('warning')
    expect(verdictOf(arms([30, 20], [30, 15])).text).toBe(
      'No effect seen: 0.67 failed checks a turn with lessons, 0.50 without.',
    )
  })

  test('no failures anywhere is no effect, not a win', () => {
    expect(verdictOf(arms([30, 0], [30, 0])).tone).toBe('warning')
  })
})

// --------------------------------------------------------- through the engine

type World = { contexts: string[][]; toasts: string[]; failing: boolean; reply: string; forks: number }

function world(on: On, saved: Record<string, unknown> = {}): World {
  const state: World = {
    contexts: [],
    toasts: [],
    failing: false,
    reply: '{"when": "the eval hangs on CI", "do": "set --workers 1", "tags": ["eval", "ci", "hang"]}',
    forks: 0,
  }

  mock.store(on, saved)
  mock.clock(on, { now: 1000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.fork', () => {
    state.forks += 1

    return {
      value: {
        isAnswered: true,
        text: state.reply,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('prompt.submit', ($, e) => {
    state.contexts.push([...(e.context ?? [])])

    return { text: e.text, context: e.context }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => (state.failing ? { isError: true, result: 'Exit code 1', text: 'Exit code 1' } : { result: {} }))

  return state
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const DONE = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
const run = (args: string) =>
  ({ command: 'bank', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const
const BASH = { tool: 'Bash', command: 'pytest -q' } as const
const BANKED = { [`lessons:${ROOT}`]: [MIGRATE, FIXTURE] }

describe('the loop', () => {
  test('a failure made to pass becomes a lesson, and a later prompt gets it', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    await $.prompt.submit(prompt('get the eval running on ci'))
    state.failing = true
    await $.tool.call({ ...BASH, tool_use_id: 'b1' })
    state.failing = false
    await $.tool.call({ ...BASH, tool_use_id: 'b2' })
    await $.turn.complete(DONE)

    expect(state.forks).toBe(1)
    expect(state.toasts).toEqual(['Lesson saved: when the eval hangs on CI'])

    await $.prompt.submit(prompt('the eval is hanging again on CI'))

    expect(state.contexts[1]?.[0]).toMatch(/- When the eval hangs on CI: set --workers 1/)
  })

  test('a turn with no failure, or one that never recovers, calls no model', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    await $.prompt.submit(prompt('run the tests'))
    await $.tool.call({ ...BASH, tool_use_id: 'b1' })
    await $.turn.complete(DONE)

    await $.prompt.submit(prompt('run them again'))
    state.failing = true
    await $.tool.call({ ...BASH, tool_use_id: 'b2' })
    await $.turn.complete(DONE)

    expect(state.forks).toBe(0)
  })

  test('a model that finds nothing reusable saves nothing', async ($, on) => {
    const state = world(on)

    state.reply = '{"skip": true}'
    await $.session.start(START)
    await $.prompt.submit(prompt('fix it'))
    state.failing = true
    await $.tool.call({ ...BASH, tool_use_id: 'b1' })
    state.failing = false
    await $.tool.call({ ...BASH, tool_use_id: 'b2' })
    await $.turn.complete(DONE)
    await $.prompt.submit(prompt('the eval is hanging again on CI'))

    expect(state.toasts).toEqual([])
    expect(state.contexts[1]).toEqual([])
  })

  test('off means off: nothing handed over, nothing learned, no model called', async ($, on) => {
    const state = world(on, BANKED)

    await $.session.start(START)
    await $.command.run(run('off'))
    await $.prompt.submit(prompt('add a database migration'))
    state.failing = true
    await $.tool.call({ ...BASH, tool_use_id: 'b1' })
    state.failing = false
    await $.tool.call({ ...BASH, tool_use_id: 'b2' })
    await $.turn.complete(DONE)

    expect(state.contexts[0]).toEqual([])
    expect(state.forks).toBe(0)
  })

  test('lessons and the mode outlive the session', async ($, on) => {
    const state = world(on, { ...BANKED, [`mode:${ROOT}`]: 'on' })

    await $.session.start(START)
    await $.prompt.submit(prompt('add a database migration for orders'))

    expect(state.contexts[0]?.[0]).toMatch(/When a database migration fails on a locked table/)
  })
})

describe('the trial, live', () => {
  test('turns a lesson fits alternate between getting it and not, and both are counted', async ($, on) => {
    const state = world(on, BANKED)

    state.reply = '{"skip": true}'
    await $.session.start(START)
    await $.command.run(run('test'))

    for (const failing of [false, true, false, true]) {
      await $.prompt.submit(prompt('add a database migration for orders'))
      state.failing = failing
      await $.tool.call({ ...BASH, tool_use_id: `b${state.contexts.length}` })
      await $.turn.complete(DONE)
    }

    // A turn no lesson fits is not part of the trial.
    await $.prompt.submit(prompt('write the release notes'))
    await $.turn.complete(DONE)

    expect(state.contexts.map(context => context.length)).toEqual([1, 0, 1, 0, 0])

    const pane = await $.ui.mount({
      plugin: 'reasoning-bank-mod',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bank',
      props: { title: 'ReasoningBank', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })

    await pane.press({ key: 'tab-trial' })
    expect(await pane.find({ type: 'Text', text: 'With lessons: 2 turns · 0 failed of 2 checks · 0.00 a turn' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Without: 2 turns · 2 failed of 2 checks · 1.00 a turn' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Not enough turns yet: 2 of 30/ })).toBeDefined()
    await pane.unmount()
  })
})

describe('by hand', () => {
  test('a lesson can be typed, listed and forgotten', async ($, on) => {
    world(on)
    await $.session.start(START)

    expect((await $.command.run(run('add the tests hang => run them with -x first'))).text).toBe(
      'Saved: When the tests hang: run them with -x first',
    )

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({
        plugin: 'reasoning-bank-mod',
        surface,
        component: 'Pane',
        requestId: 'bank',
        props: { title: 'ReasoningBank', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      })

      expect(await pane.find({ type: 'Text', text: 'When the tests hang' })).toBeDefined()
      await pane.unmount()
    }

    expect((await $.command.run(run('forget 1'))).text).toBe('Forgot: When the tests hang')
    expect((await $.command.run(run('forget 1'))).text).toMatch(/Give the number shown/)
  })

  test('the band says when lessons went to Claude', async ($, on) => {
    world(on, BANKED)
    await $.session.start(START)
    await $.prompt.submit(prompt('add a database migration for orders'))

    const band = await $.ui.mount({
      plugin: 'reasoning-bank-mod',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })

    expect(await band.find({ type: 'Text', text: '1 lesson handed to Claude' })).toBeDefined()
    await band.unmount()
  })
})
