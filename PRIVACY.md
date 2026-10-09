# Privacy

Last updated: October 9, 2026

ReasoningBank Lite is a mod that runs inside Claude Code on your own machine. It has no server and no account.

## What it collects

Nothing. ReasoningBank Lite does not collect, transmit or share any data with its author or any third party. It makes no network requests of its own and sends no telemetry or analytics. The author receives no information about you or your use of it.

## What it handles on your machine

To do its job, ReasoningBank Lite works with the following, all of which stay on your computer:

- **During a session, in memory:** the shell commands Claude runs and whether each failed, used to count checks in the current turn, and the words of each prompt you send, used to find lessons that fit.
- **Between sessions, on disk:** up to 200 lessons for each project, each holding a situation, what to do, a few keywords, when it was saved and how often it was used; the trial's counts of turns, checks and failed checks; and whether the mod is on, off or in test mode. These are kept in Claude Code's own plugin store on your machine, keyed by your project's path.

## The model call

After a turn in which a failing check was made to pass, the mod asks Claude for the lesson in it. That request goes through your own Claude Code session to the model you are already using, and includes the session's conversation, exactly as your own next message would. It is handled under the same terms as everything else you send through Claude Code. With the mod set to off, no model call is made.

## What it adds to your conversation

When saved lessons fit a prompt, up to three of them are added to that prompt as context Claude reads. That text goes to the model along with the rest of your conversation.

A lesson is written by the model from your session, so it can contain names of files, commands or errors from your project. Lessons never leave your machine except as context in your own later prompts.

## Removing its data

`/bank forget <number>` deletes one lesson, and `/bank reset` clears the trial. Uninstalling the plugin stops everything above. The stored data lives in Claude Code's plugin store under `~/.claude/plugins/store/` and can be deleted there.

## What ReasoningBank Lite does not cover

ReasoningBank Lite runs inside Claude Code. How Claude Code and Anthropic handle your prompts, code and usage is governed by Anthropic's own policies, not this one.

## Changes

Any change to this policy will be made in this file, and the history is visible in the repository.

## Contact

Questions or concerns: open an issue at https://github.com/ramankrishna/reasoning-bank-mod/issues
