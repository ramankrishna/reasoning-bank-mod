// The bank's rules, with no engine in them: every function here is pure, so
// the tests and the hooks read the same judgement. Recall is word overlap, not
// a model: the same prompt always recalls the same lessons.

import type { Arm, Lesson, Trial, TurnState } from '../types'

export const MAX_LESSONS = 200
export const RECALL = 3

/** The turns each arm needs before the trial says anything. */
export const MIN_TURNS = 30

/** How much lower the failure rate must be with lessons to count as helping. */
export const MIN_DROP = 0.2

export const NO_TURN: TurnState = { arm: null, applied: [], checks: 0, failures: 0, hasRecovered: false }
export const NO_TRIAL: Trial = {
  with: { turns: 0, checks: 0, failures: 0 },
  without: { turns: 0, checks: 0, failures: 0 },
}

// --------------------------------------------------------------- watching

const TESTLIKE = new RegExp(
  [
    String.raw`\bpytest\b`,
    String.raw`\bpy\.test\b`,
    String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
    String.raw`\b(tox|nox)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)\b`,
    String.raw`\bnpx\s+(jest|vitest|tsc|eslint|playwright)\b`,
    String.raw`\b(jest|vitest|mocha)\b`,
    String.raw`\bcargo\s+(test|check|clippy|build)\b`,
    String.raw`\bgo\s+(test|vet|build)\b`,
    String.raw`\bmake(\s+[\w-]+)?\s*$`,
    String.raw`(\bmvn|\bgradle|\./gradlew)\s+(test|verify|check|build)\b`,
    String.raw`\btsc\b`,
    String.raw`\b(ruff|mypy|eslint|flake8)\b`,
    String.raw`\b(rspec|phpunit|ctest)\b`,
    String.raw`\b(dotnet|swift)\s+(test|build)\b`,
    String.raw`\bclaude\s+plugin\s+(test|validate)\b`,
  ].join('|'),
)

const NOT_A_RUN =
  /^\s*(cat|grep|rg|ls|echo|which|head|tail|sed|awk|find|cd|export|git)\b|\b(install|uninstall|add|remove)\b/

/** True when some part of the command runs tests, a build, a linter or a type check. */
export function isCheck(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some(part => TESTLIKE.test(part) && !NOT_A_RUN.test(part))
}

/** Counts one check into the turn; a pass after a failure marks the turn as a recovery. */
export function recordCheck(turn: TurnState, ok: boolean): TurnState {
  return {
    ...turn,
    checks: turn.checks + 1,
    failures: turn.failures + (ok ? 0 : 1),
    hasRecovered: turn.hasRecovered || (ok && turn.failures > 0),
  }
}

// ----------------------------------------------------------------- recall

const STOP = new Set(
  (
    'the and for with that this from have has had not but are was were will would should could can ' +
    'you your our its into out about when what which how why then than them they there here just ' +
    'also any all some one two use using used get got make made need want please let lets now new ' +
    'add fix run file files code does did done its it is in on at to of a an be as by or if so we i'
  ).split(' '),
)

/** The words of a text that carry meaning, lowercased and lightly stemmed. */
export function wordsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []

  return [
    ...new Set(
      words
        .filter(word => !STOP.has(word))
        .map(word =>
          word.length > 5 && word.endsWith('ing')
            ? word.slice(0, -3)
            : word.length > 4 && word.endsWith('ed')
              ? word.slice(0, -2)
              : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
                ? word.slice(0, -1)
                : word,
        ),
    ),
  ]
}

/** How well a lesson fits a prompt: a tag in common counts double a word in common. */
export function scoreOf(lesson: Lesson, prompt: readonly string[]): number {
  const asked = new Set(prompt)
  const tags = new Set(wordsOf(lesson.tags.join(' ')))
  const tagHits = [...tags].filter(tag => asked.has(tag)).length
  const wordHits = wordsOf(lesson.when).filter(word => !tags.has(word) && asked.has(word)).length

  // A lesson needs a tag in common and one thing more, or it is a coincidence.
  return tagHits >= 1 && tagHits * 2 + wordHits >= 3 ? tagHits * 2 + wordHits : 0
}

/** The lessons that fit a prompt, best first, at most three. */
export function recall(lessons: readonly Lesson[], prompt: string): Lesson[] {
  const asked = wordsOf(prompt)

  return lessons
    .map(lesson => ({ lesson, score: scoreOf(lesson, asked) }))
    .filter(one => one.score > 0)
    .sort((a, b) => b.score - a.score || b.lesson.uses - a.lesson.uses || b.lesson.at - a.lesson.at)
    .slice(0, RECALL)
    .map(one => one.lesson)
}

/** What Claude reads beside a prompt the bank has lessons for. */
export function briefing(lessons: readonly Lesson[]): string {
  return [
    'Lessons from earlier sessions in this project (ReasoningBank Lite). Each was saved when a failing check was made to pass.',
    'Use one only where it fits this task, and say so when you do:',
    ...lessons.map(lesson => `- When ${lesson.when}: ${lesson.do}`),
  ].join('\n')
}

// ---------------------------------------------------------------- learning

/** What the model is asked after a turn in which a failing check was made to pass. */
export const QUESTION = [
  'In the turn that just ended, a check failed and was then made to pass.',
  'Write the one lesson from it that would save time in a future session on this project.',
  'Reply with JSON only, on one line:',
  '{"when": "the situation, under 120 characters", "do": "what to do, under 160 characters", "tags": ["three to six lowercase keywords someone would use when asking for similar work"]}.',
  'If the failure was a one-off slip with nothing reusable in it, reply {"skip": true}.',
  'Do not call any tool.',
].join(' ')

const tidy = (text: unknown, most: number): string =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().replace(/^when\s+/i, '').slice(0, most) : ''

/** Reads the model's reply; answers the lesson's parts, or null when there is none. */
export function parseLesson(reply: string): Pick<Lesson, 'when' | 'do' | 'tags'> | null {
  const found = /\{[\s\S]*\}/.exec(reply)

  if (found === null) return null

  let data: unknown

  try {
    data = JSON.parse(found[0])
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null) return null

  const { when, do: action, tags } = data as Record<string, unknown>
  const lesson = {
    when: tidy(when, 140),
    do: tidy(action, 200),
    tags: Array.isArray(tags)
      ? [...new Set(tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.toLowerCase().trim()))]
          .filter(tag => /^[a-z0-9][a-z0-9 _.-]{1,30}$/.test(tag))
          .slice(0, 6)
      : [],
  }

  return lesson.when === '' || lesson.do === '' || lesson.tags.length === 0 ? null : lesson
}

/** Reads a lesson typed by hand: `when the tests hang => run them with -x first`. */
export function parseTyped(text: string): Pick<Lesson, 'when' | 'do' | 'tags'> | null {
  const [left, ...rest] = text.split('=>')
  const when = tidy(left, 140)
  const action = tidy(rest.join('=>'), 200)

  if (when === '' || action === '') return null

  return { when, do: action, tags: wordsOf(when).slice(0, 6) }
}

const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const same = (a: string, b: string): boolean => plain(a) === plain(b)

/**
 * Adds a lesson to the bank. One that says what a kept lesson says is not
 * added twice; past the bank's size, the least used and oldest gives way.
 */
export function addLesson(
  lessons: readonly Lesson[],
  parts: Pick<Lesson, 'when' | 'do' | 'tags'>,
  at: number,
  source: Lesson['source'],
): Lesson[] {
  if (lessons.some(lesson => same(lesson.when, parts.when) && same(lesson.do, parts.do))) return [...lessons]

  const lesson: Lesson = { id: `${at.toString(36)}-${lessons.length}`, at, uses: 0, source, ...parts }
  const all = [...lessons, lesson]

  if (all.length <= MAX_LESSONS) return all

  const weakest = [...all.slice(0, -1)].sort((a, b) => a.uses - b.uses || a.at - b.at)[0]

  return all.filter(one => one.id !== weakest?.id)
}

export const markUsed = (lessons: readonly Lesson[], ids: readonly string[]): Lesson[] =>
  lessons.map(lesson => (ids.includes(lesson.id) ? { ...lesson, uses: lesson.uses + 1 } : lesson))

// ------------------------------------------------------------------ trial

/** Which arm the next eligible turn of a trial goes to: the two alternate. */
export const nextArm = (trial: Trial): 'with' | 'without' =>
  trial.with.turns <= trial.without.turns ? 'with' : 'without'

export function recordTurn(trial: Trial, turn: TurnState): Trial {
  if (turn.arm === null) return trial

  const was: Arm = trial[turn.arm]

  return {
    ...trial,
    [turn.arm]: { turns: was.turns + 1, checks: was.checks + turn.checks, failures: was.failures + turn.failures },
  }
}

const rate = (arm: Arm): number => (arm.turns === 0 ? 0 : arm.failures / arm.turns)

export type Verdict = { tone: 'success' | 'warning' | null; text: string }

/**
 * What the trial shows, by the rule set before any data came in: at least
 * thirty turns in each arm, and a failure rate at least a fifth lower with
 * lessons, or it is not a result.
 */
export function verdictOf(trial: Trial): Verdict {
  const short = Math.min(trial.with.turns, trial.without.turns)

  if (short < MIN_TURNS) {
    return { tone: null, text: `Not enough turns yet: ${short} of ${MIN_TURNS} in the smaller arm.` }
  }

  const withRate = rate(trial.with)
  const withoutRate = rate(trial.without)

  if (withoutRate > 0 && withRate <= withoutRate * (1 - MIN_DROP)) {
    return {
      tone: 'success',
      text: `Fewer failed checks with lessons: ${withRate.toFixed(2)} a turn against ${withoutRate.toFixed(2)}.`,
    }
  }

  return {
    tone: 'warning',
    text: `No effect seen: ${withRate.toFixed(2)} failed checks a turn with lessons, ${withoutRate.toFixed(2)} without.`,
  }
}

export const armLine = (arm: Arm): string =>
  `${arm.turns} ${arm.turns === 1 ? 'turn' : 'turns'} · ${arm.failures} failed of ${arm.checks} checks · ${rate(arm).toFixed(2)} a turn`

export const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 3))}...` : text
