# onehook-noslop

A pre-edit hook for coding agents that blocks the quantifier couplet: two quantity phrases set in mirror, as in "Four moments, one job", "One app, many teams", "Five rooms, no waiting" or "Three signals. One job." Language models write this construct often in headings and copy.

The hook runs before the agent writes or edits a file. When the new text contains a couplet, the agent's edit is rejected and the agent gets a message that tells it to restate the point plainly.

The script is one file with no dependencies. It runs on Node 18 or later, or on Bun.

## Supported agents

| Agent | User config | Project config | Hook event |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `.claude/settings.json` | `PreToolUse` on `Write`, `Edit`, `MultiEdit` |
| OpenAI Codex | `~/.codex/hooks.json` | `.codex/hooks.json` | `PreToolUse` on `apply_patch`, `Edit`, `Write` |
| Cursor | `~/.cursor/hooks.json` | `.cursor/hooks.json` | `preToolUse` |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` | `BeforeTool` on `write_file`, `replace` |
| GitHub Copilot CLI | `~/.copilot/hooks/onehook-noslop.json` | `.github/hooks/onehook-noslop.json` | `preToolUse` |

The hook reads the input format of each agent. For Codex and Copilot `apply_patch` calls, it splits the patch by file and checks only the added lines. It answers each agent in the form that agent expects: exit code 2 with the reason on stderr, a JSON `deny` for Cursor, and both for Copilot. If it cannot read the input, it allows the edit.

## What it detects

| Pattern | Example | Result |
| --- | --- | --- |
| Number phrase, then a comma, semicolon or colon, then a number | "Two kinds of proposal; one decision" | Blocked |
| Number phrase and a vague quantity in mirror | "One app, many teams", "Five rooms, no waiting", "Zero config, one command" | Blocked |
| Short sentence that opens on a quantity, then another such sentence | "Three signals. One job." | Blocked |
| Digits in the same pattern | "5 screens, 1 flow" | Blocked |
| Two vague quantities with no number | "No meetings, no fluff" | Allowed |
| Counts joined with "and" | "two bistros and three wine bars" | Allowed |

The vague quantities are `many`, `few`, `no`, `zero`, `several`, `countless`, `endless` and `infinite`. At least one side of the pair must be a number.

To keep a real count, join the items with "and" instead of a comma.

The hook checks only files with these extensions: `.md`, `.mdx`, `.txt`, `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.html` and `.vtt`. It skips other files.

This repository fails its own check, because the README and the package description quote couplets as examples.

## Install

```sh
npx onehook-noslop install
```

Without options, the installer adds the hook to every agent from the table that has a user config folder on your machine. To choose the agents, use `--agent`:

```sh
npx onehook-noslop install --agent claude,codex
npx onehook-noslop install --agent all
```

For each agent, the installer does these steps:

1. It copies `couplets.mjs` to a `hooks/onehook-noslop/` folder in that agent's config folder.
2. It adds the hook entry to the agent's config file. It keeps all other settings and hooks.
3. It saves the previous config file with the suffix `.bak-onehook-noslop`.

The installer reads every config file before it writes any. If one file is not valid JSON, it stops and changes nothing.

Each edit runs the local copy of the script, so the hook does not need network access. If you run the installer again, it replaces its own entries and does not add second ones. The installer uses `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` when they are set.

To see the changes before you apply them, add `--dry-run`.

After the install, restart the agent. Codex runs a new hook only after you trust it: open `/hooks` in Codex and trust the `onehook-noslop` entry.

### Install for one project

Run this in the project root:

```sh
npx onehook-noslop install --project --agent all
```

The installer writes the project config files from the table and copies the script into each agent's project folder. Commit these files so the hook applies to everyone who works on the project.

Copilot CLI also reads `.claude/settings.json`. If you install for both Claude Code and Copilot in one project, Copilot can run the hook twice. This does no harm.

## Uninstall

```sh
npx onehook-noslop uninstall                     # agents with a user config folder
npx onehook-noslop uninstall --agent codex       # one agent
npx onehook-noslop uninstall --project --agent all
```

The command removes the hook entries and the copied scripts. Other hooks stay.

## Skip files

The hook skips paths that contain `node_modules/`, `.next/`, `dist/` or `.git/`, and the script itself. To skip more paths, set `NOSLOP_ALLOW` to a comma-separated list of path fragments, for example a style guide that quotes couplets as bad examples. Put the variable in front of the hook command in the agent's config file:

```json
"command": "NOSLOP_ALLOW=docs/style-guide.md,imports/ node \"/Users/you/.claude/hooks/onehook-noslop/couplets.mjs\" --hook"
```

## Scan existing files

Run the scan command with files or directories as arguments:

```sh
npx onehook-noslop scan docs src/content
```

The command prints each hit with its line number. It exits with code 1 when it finds a hit, so you can use it in CI.

## Run the tests

```sh
npm test
```

## Limits

The patterns are regular expressions. They do not find every couplet, and some valid sentences can match. If a valid sentence is blocked, join the counts with "and" or add the file to `NOSLOP_ALLOW`.

The hook checks text that goes through the agent's file edit tools. It does not check files that the agent writes with shell commands.

## License

MIT
