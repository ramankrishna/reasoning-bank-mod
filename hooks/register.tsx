// ReasoningBank Lite: lessons from the times a failing check was made to pass.
//
// Learn: after a turn in which a check failed and then passed, the model is
// asked for the one lesson in it, and the lesson is saved for the project.
// Recall: a later prompt that shares words with a lesson carries it to Claude.
// Trial: an on/off comparison, built in, says whether any of this helps.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Lesson, Mode, Tab, Trial } from '../types'
import {
  addLesson,
  armLine,
  briefing,
  clip,
  isCheck,
  markUsed,
  MIN_DROP,
  MIN_TURNS,
  nextArm,
  NO_TRIAL,
  NO_TURN,
  parseLesson,
  parseTyped,
  QUESTION,
  recall,
  recordCheck,
  recordTurn,
  verdictOf,
} from './bank'

const PANE = 'bank'

const lessons = atom({ plugin: 'reasoning-bank-mod', key: 'lessons' } as const, [])
const mode = atom({ plugin: 'reasoning-bank-mod', key: 'mode' } as const, 'on')
const turn = atom({ plugin: 'reasoning-bank-mod', key: 'turn' } as const, NO_TURN)
const trial = atom({ plugin: 'reasoning-bank-mod', key: 'trial' } as const, NO_TRIAL)
const tab = atom({ plugin: 'reasoning-bank-mod', key: 'tab' } as const, 'lessons')
const note = atom({ plugin: 'reasoning-bank-mod', key: 'note' } as const, '')

let root = ''

const key = (name: string): string => `${name}:${root}`

const isMode = (value: unknown): value is Mode => value === 'on' || value === 'off' || value === 'test'

/** Reads the project's lessons, its trial and its mode from the store. */
async function load($: EngineInterface): Promise<void> {
  root = await $.session.root()

  const savedLessons = await $.store.get(key('lessons'))
  const savedTrial = (await $.store.get(key('trial'))) as Trial | undefined
  const savedMode = await $.store.get(key('mode'))

  await update($, lessons, () => (Array.isArray(savedLessons) ? (savedLessons as Lesson[]) : []))
  await update($, trial, () => (savedTrial?.with !== undefined && savedTrial.without !== undefined ? savedTrial : NO_TRIAL))
  await update($, mode, () => (isMode(savedMode) ? savedMode : 'on'))
}

async function saveLessons($: EngineInterface, all: Lesson[]): Promise<void> {
  await update($, lessons, () => all)
  await $.store.set(key('lessons'), all)
}

async function setMode($: EngineInterface, value: Mode): Promise<void> {
  await update($, mode, () => value)
  await $.store.set(key('mode'), value)
}

async function forget($: EngineInterface, id: string): Promise<void> {
  await saveLessons(
    $,
    (await read($, lessons)).filter(lesson => lesson.id !== id),
  )
}

async function resetTrial($: EngineInterface): Promise<void> {
  await update($, trial, () => NO_TRIAL)
  await $.store.set(key('trial'), NO_TRIAL)
}

/** Asks the model for the lesson in the turn that just ended, and banks it. */
async function learn($: EngineInterface): Promise<void> {
  let said = ''

  try {
    const reply = await $.model.fork({ prompt: QUESTION })

    if (!reply.isAnswered) {
      await update($, note, () => `No lesson saved last time: the model call did not answer (${reply.reason}).`)

      return
    }

    said = reply.text
  } catch {
    await update($, note, () => 'No lesson saved last time: the model could not be asked.')

    return
  }

  const parts = parseLesson(said)

  if (parts === null) {
    await update($, note, () => 'No lesson saved last time: the model found nothing reusable.')

    return
  }

  const before = await read($, lessons)
  const all = addLesson(before, parts, await $.clock.now(), 'learned')

  if (all.length === before.length && all.every((lesson, index) => lesson.id === before[index]?.id)) {
    await update($, note, () => 'No lesson saved last time: the bank already holds it.')

    return
  }

  await saveLessons($, all)
  await update($, note, () => `Last saved: When ${parts.when}`)
  $.ui.toast(`Lesson saved: when ${clip(parts.when, 80)}`)
}

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: 'ReasoningBank Lite', focus: true, closeOnEscape: true })

const USAGE =
  'Usage: /bank, /bank on, /bank off, /bank test, /bank add <situation> => <what to do>, /bank forget <number>, /bank reset'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bank',
      description: 'Lessons from past failures in this project, and whether they help',
      argumentHint: '[on|off|test|add|forget|reset]',
    })
    await load($)

    return next(e)
  })

  // /clear, /resume and /branch reset the session's state and raise no session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)

    return next(e)
  })

  on('command.run', { command: 'bank' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = '', ...rest] = args.split(/\s+/).filter(Boolean)

    await load($)

    if (verb === '') {
      await openPane($)

      return {}
    }
    if (isMode(verb)) {
      await setMode($, verb)

      return {
        text:
          verb === 'on'
            ? 'ReasoningBank Lite is on: lessons are learned and handed to Claude.'
            : verb === 'off'
              ? 'ReasoningBank Lite is off: nothing is learned or handed over, and no model is called.'
              : `Trial started: turns a lesson fits alternate between getting it and not. It reports after ${MIN_TURNS} turns each way.`,
      }
    }
    if (verb === 'add') {
      const parts = parseTyped(args.slice(3))

      if (parts === null) return { text: 'Write it as: /bank add <situation> => <what to do>' }

      await saveLessons($, addLesson(await read($, lessons), parts, await $.clock.now(), 'typed'))

      return { text: `Saved: When ${parts.when}: ${parts.do}` }
    }
    if (verb === 'forget') {
      const shown = [...(await read($, lessons))].reverse()
      const lesson = shown[Number(rest[0]) - 1]

      if (lesson === undefined) return { text: 'Give the number shown beside the lesson in /bank.' }

      await forget($, lesson.id)

      return { text: `Forgot: When ${lesson.when}` }
    }
    if (verb === 'reset') {
      await resetTrial($)

      return { text: 'The trial counts are back to zero.' }
    }

    return { text: USAGE }
  })

  // --------------------------------------------------------------- recall

  on('prompt.submit', async ($, e, next) => {
    // A prompt folded into a running turn is part of that turn, not a new one.
    if (e.turnId !== undefined) return next(e)

    const now = await read($, mode)
    const all = await read($, lessons)
    const fit = now === 'off' ? [] : recall(all, e.text)
    const arm = now === 'test' && fit.length > 0 ? nextArm(await read($, trial)) : null
    const isHanded = fit.length > 0 && arm !== 'without'
    const ids = fit.map(lesson => lesson.id)

    await update($, turn, () => ({ ...NO_TURN, arm, applied: isHanded ? ids : [] }))

    if (!isHanded) return next(e)

    await saveLessons($, markUsed(all, ids))

    return next({ ...e, context: [...(e.context ?? []), briefing(fit)] })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny !== undefined || !isCheck(e.command)) return ran

    const record = ran.isError === true ? undefined : ran.result

    if (record?.backgroundTaskId !== undefined) return ran

    const ok = ran.isError !== true && record?.interrupted !== true

    await update($, turn, was => recordCheck(was, ok))

    return ran
  })

  // -------------------------------------------------------------- learning

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) return done

    const now = await read($, mode)
    const ended = await read($, turn)

    // Counted once: the turn's tally is cleared as it is recorded.
    await update($, turn, () => NO_TURN)

    if (now === 'test' && ended.arm !== null) {
      const counted = recordTurn(await read($, trial), ended)

      await update($, trial, () => counted)
      await $.store.set(key('trial'), counted)
    }
    if (now !== 'off' && ended.hasRecovered && e.reason === 'answer') await learn($)

    return done
  })

  // -------------------------------------------------------------- drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, turn)

    if (e.props.hasSurvey || (now.applied.length === 0 && now.arm !== 'without')) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const count = now.applied.length

    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" columnGap={2}>
          <Text inverse> bank </Text>
          {now.arm === 'without' ? (
            <Text color="warning">trial: lessons held back this turn</Text>
          ) : (
            <Text dimColor>
              {count} {count === 1 ? 'lesson' : 'lessons'} handed to Claude
            </Text>
          )}
          <Button key="open" label="bank" hotkey="b" plain onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, lessons)
    const now = await read($, mode)
    const counts = await read($, trial)
    const shown = await read($, tab)
    const last = await read($, note)
    const width = Math.max(24, e.props.bodyColumns - 8)
    const verdict = verdictOf(counts)

    const tabButton = (to: Tab, label: string, hotkey: string) => (
      <Button
        key={`tab-${to}`}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={shown !== to}
        onPress={() => update($, tab, () => to)}
      />
    )
    const modeButton = (to: Mode, hotkey: string) => (
      <Button
        key={`mode-${to}`}
        label={to}
        hotkey={hotkey}
        plain
        dimColor={now !== to}
        onPress={() => setMode($, to)}
      />
    )

    const list = (
      <Box flexDirection="column" rowGap={1}>
        {all.length === 0 && (
          <Box flexDirection="column">
            <Text>No lessons yet.</Text>
            <Text dimColor>One is saved when a failing check is made to pass in a turn.</Text>
            <Text dimColor>{'Or type one: /bank add the tests hang => run them with -x first'}</Text>
          </Box>
        )}
        {[...all]
          .reverse()
          .slice(0, 12)
          .map((lesson, index) => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>{index + 1}.</Text>
                <Text>When {clip(lesson.when, width)}</Text>
              </Box>
              <Text dimColor>{clip(lesson.do, width + 4)}</Text>
              <Box flexDirection="row" columnGap={2}>
                <Text dimColor>
                  used {lesson.uses} {lesson.uses === 1 ? 'time' : 'times'} {'·'} {lesson.source}
                </Text>
                <Button key={`forget-${lesson.id}`} label="forget" plain dimColor onPress={() => forget($, lesson.id)} />
              </Box>
            </Box>
          ))}
        {last !== '' && <Text dimColor>{clip(last, width + 4)}</Text>}
      </Box>
    )

    const comparison = (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text dimColor>In test mode, turns a lesson fits alternate between getting it and not.</Text>
          <Text dimColor>
            The rule, set in advance: {MIN_TURNS} turns each way, and at least {Math.round(MIN_DROP * 100)}% fewer failed
            checks a turn with lessons.
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text>With lessons: {armLine(counts.with)}</Text>
          <Text>Without: {armLine(counts.without)}</Text>
        </Box>
        {verdict.tone === null ? (
          <Text dimColor>{verdict.text}</Text>
        ) : (
          <Text color={verdict.tone}>{verdict.text}</Text>
        )}
        <Button key="reset" label="r: reset the trial" hotkey="r" onPress={() => resetTrial($)} />
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={3}>
          {tabButton('lessons', `Lessons (${all.length})`, '1')}
          {tabButton('trial', 'Trial', '2')}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>Mode:</Text>
          {modeButton('on', 'o')}
          {modeButton('off', 'f')}
          {modeButton('test', 't')}
        </Box>
        {shown === 'lessons' ? list : comparison}
      </Box>
    )
  })
}
