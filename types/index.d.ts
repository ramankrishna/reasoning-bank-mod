/** One thing learned: a situation, and what to do in it. */
export type Lesson = {
  id: string
  /** When it was saved, in milliseconds. */
  at: number
  /** The situation, completing "When ...". */
  when: string
  do: string
  tags: string[]
  /** How many prompts it has been handed to Claude beside. */
  uses: number
  /** `learned` from a turn by the model, or `typed` by the person. */
  source: 'learned' | 'typed'
}

/** What one turn has seen so far. */
export type TurnState = {
  /** In a trial, which arm the turn is in; null when the turn is not part of one. */
  arm: 'with' | 'without' | null
  /** The lessons handed to Claude beside this turn's prompt. */
  applied: string[]
  checks: number
  failures: number
  /** True once a check passed after one failed. */
  hasRecovered: boolean
}

export type Arm = { turns: number; checks: number; failures: number }

/** The on/off comparison: turns with lessons against turns without. */
export type Trial = { with: Arm; without: Arm }

export type Mode = 'on' | 'off' | 'test'

export type Tab = 'lessons' | 'trial'

declare module 'claude-code' {
  interface PluginState {
    'reasoning-bank-mod': {
      lessons: Lesson[]
      mode: Mode
      turn: TurnState
      trial: Trial
      tab: Tab
      /** What the last attempt to learn came to, for the pane. */
      note: string
    }
  }
}
