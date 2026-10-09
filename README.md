# ReasoningBank Lite

A mod for Claude Code that keeps the lessons from past failures in a project, hands them to Claude when similar work comes up, and measures whether doing so helps.

**Read this first: it is unproven.** The idea is plausible and easy to believe. The author's fuller implementation, [reasoning-bank](https://github.com/ramankrishna/reasoning-bank), ran a suite of experiments and reports in its README that it found no setting where accumulated memory produced a net gain. This mod does not assume a different outcome. It ships with an on/off trial so you can find out on your own work, and the rule for reading that trial was fixed before any data existed.

## Where the idea comes from

The idea is from the ReasoningBank paper (Ouyang et al., [arXiv:2509.25140](https://arxiv.org/abs/2509.25140)): an agent distils lessons from past attempts and retrieves them on new tasks. This mod is a much smaller take on that idea, not an implementation of the paper. It learns only from one signal, a failing check made to pass, and it recalls by word overlap. It has no trajectory judging, no embeddings and no test-time scaling. It is not affiliated with the paper's authors.

## How it works

**Learn.** The mod watches the test, build and lint commands Claude runs. When a turn contains a failing check that is later made to pass, the mod asks the model one question at the end of the turn: what is the one lesson here that would save time next time? The answer is saved as a short pair, a situation and what to do in it, with a few keywords. If the model says the failure was a one-off slip, nothing is saved.

**Recall.** When you send a prompt, the mod compares its words with the saved lessons. A lesson is handed to Claude only if it shares a keyword and at least one more word with the prompt. At most three are handed over, as context beside your prompt, with a note to use them only where they fit. Recall is plain word matching, not a model, so the same prompt always recalls the same lessons.

**Measure.** In test mode, turns that a lesson fits alternate between getting the lesson and not getting it. The mod counts failed checks in each group.

## The rule for reading the trial

Set in advance, and written into the code as `MIN_TURNS` and `MIN_DROP`:

- **At least 30 turns in each group.** Before that the trial says only "not enough turns yet".
- **At least 20% fewer failed checks per turn with lessons.** Anything less is reported as "no effect seen".

If your trial reports no effect, the honest move is to turn the mod off.

## Install

```
/plugin install reasoning-bank-mod --marketplace ramankrishna/reasoning-bank-mod
```

Answer `y` to add the marketplace, then pick a scope. Needs Claude Code v2.1.287 or later.

| Command | What it does |
| :- | :- |
| `/bank` | Opens the lessons and the trial |
| `/bank on` | Learn and recall. This is the default |
| `/bank off` | Fully off: nothing learned, nothing handed over, no model called |
| `/bank test` | Runs the on/off trial |
| `/bank add <situation> => <what to do>` | Saves a lesson you type yourself |
| `/bank forget <number>` | Deletes the lesson with that number in `/bank` |
| `/bank reset` | Sets the trial counts back to zero |

A line above the prompt tells you when lessons were handed to Claude, or held back by the trial.

## What it runs, reads and stores

- **Calls the model** at the end of a turn in which a failing check was made to pass, and only then. The call goes through your own Claude Code session, reads the session's conversation, and costs tokens on your account. It also adds a few seconds to the end of such a turn.
- **Adds text to your prompts.** When lessons fit, each prompt carries up to three of them to Claude as hidden context.
- **Reads** the shell commands Claude runs and whether each failed, to spot checks.
- **Stores** on your machine, in Claude Code's plugin store, keyed by the project's path: the lessons (at most 200), the trial counts, and the mode.
- **Sends nothing** anywhere else. No network calls of its own, no telemetry.

Like every mod, it runs with the same access to your machine as Claude Code itself. The full statement is in [PRIVACY.md](PRIVACY.md).

## Limits

- **The trial is small and simple.** Groups alternate; they are not randomised. The count is failed checks per turn, which depends heavily on what you happened to be working on. It can show a large effect and will miss a small one. It applies no significance test.
- **Only turns a lesson fits are in the trial.** That is the right comparison, and it means the trial fills slowly.
- **A lesson is the model's opinion.** Nothing checks that a saved lesson is true or still applies. Read the list now and then, and forget the ones that are wrong.
- **Recall is word matching.** It misses a lesson phrased with different words, and can hand over one that only looks related.
- **Only recognised commands count as checks.** It knows the common test, build, lint and type-check commands. A failure in a custom script is not seen.
- **Lessons are per project and stay on your machine.** They are not shared with a team.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
