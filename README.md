# onehook-noslop

A Claude Code hook that blocks the quantifier couplet: two number phrases set in mirror, as in "Four moments, one job" or "Three signals. One job." Language models write this construct often in headings and copy.

The hook runs before every `Write`, `Edit` and `MultiEdit` call. When the new text contains a couplet, the hook exits with code 2. Claude Code then rejects the edit and shows Claude a message that tells it to restate the point plainly.

The script is one file with no dependencies. It runs on Node 18 or later, or on Bun.

## What it detects

| Pattern | Example | Result |
| --- | --- | --- |
| Number phrase, then a comma, semicolon or colon, then a number | "Two kinds of proposal; one decision" | Blocked |
| Short sentence that opens on a number word, then another such sentence | "Three signals. One job." | Blocked |
| Digits in the same pattern | "5 screens, 1 flow" | Blocked |
| Counts joined with "and" | "two bistros and three wine bars" | Allowed |

To keep a real count, join the items with "and" instead of a comma.

The hook checks only files with these extensions: `.md`, `.mdx`, `.txt`, `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.html` and `.vtt`. It skips other files.

## Install for all projects

```sh
npx onehook-noslop install
```

The installer does these steps:

1. It copies `couplets.mjs` to `~/.claude/hooks/onehook-noslop/`.
2. It adds a `PreToolUse` entry for `Write|Edit|MultiEdit` to `~/.claude/settings.json`. It keeps all other settings and hooks.
3. It saves the previous settings file as `settings.json.bak-onehook-noslop`.

Each edit runs the local copy of the script, so the hook does not need network access. If you run the installer again, it replaces its own entry and does not add a second one. If `CLAUDE_CONFIG_DIR` is set, the installer uses that directory instead of `~/.claude`.

After the install, restart Claude Code or open `/hooks` to load the hook.

To see the changes before you apply them, add `--dry-run`.

## Install for one project

Run this in the project root:

```sh
npx onehook-noslop install --project
```

The installer copies the script to `.claude/hooks/onehook-noslop/` and adds the hook to `.claude/settings.json`. Commit both so the hook applies to everyone who works on the project.

## Uninstall

```sh
npx onehook-noslop uninstall            # global
npx onehook-noslop uninstall --project  # current project
```

The command removes the hook entry and the copied script. Other hooks stay.

## Install by hand

Copy `couplets.mjs` to a location of your choice and add this to a Claude Code settings file:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/couplets.mjs\" --hook"
          }
        ]
      }
    ]
  }
}
```

## Skip files

The hook skips paths that contain `node_modules/`, `.next/`, `dist/` or `.git/`, and the script itself. To skip more paths, set `NOSLOP_ALLOW` to a comma-separated list of path fragments. For example, a style guide that quotes couplets as bad examples. Put the variable in front of the hook command in the settings file:

```json
"command": "NOSLOP_ALLOW=docs/style-guide.md,imports/ node \"$HOME/.claude/hooks/onehook-noslop/couplets.mjs\" --hook"
```

## Scan existing files

Run the scan command with files or directories as arguments:

```sh
npx onehook-noslop scan docs src/content
```

The script prints each hit with its line number. It exits with code 1 when it finds a hit, so you can use it in CI.

## Run the tests

```sh
npm test
```

## Limits

The patterns are regular expressions. They do not find every couplet, and some valid sentences can match. If a valid sentence is blocked, join the counts with "and" or add the file to `NOSLOP_ALLOW`.

## License

MIT
