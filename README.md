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

1. Clone the repository:

   ```sh
   git clone https://github.com/wisdomousai/onehook-noslop ~/.claude/onehook-noslop
   ```

2. Add the hook to `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Write|Edit|MultiEdit",
           "hooks": [
             {
               "type": "command",
               "command": "node \"$HOME/.claude/onehook-noslop/couplets.mjs\" --hook"
             }
           ]
         }
       ]
     }
   }
   ```

   If the file already has a `hooks` key, add the entry to the existing `PreToolUse` list.

3. Restart Claude Code, or open `/hooks` to reload the configuration.

## Install for one project

Copy `couplets.mjs` into the project, for example to `tools/prose/couplets.mjs`. Then add the hook to the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/tools/prose/couplets.mjs\" --hook"
          }
        ]
      }
    ]
  }
}
```

## Skip files

The hook skips paths that contain `node_modules/`, `.next/`, `dist/` or `.git/`, and the script itself. To skip more paths, set `NOSLOP_ALLOW` to a comma-separated list of path fragments. For example, a style guide that quotes couplets as bad examples:

```json
"command": "NOSLOP_ALLOW=docs/style-guide.md,imports/ node \"$HOME/.claude/onehook-noslop/couplets.mjs\" --hook"
```

## Scan existing files

Run the script with files or directories as arguments:

```sh
node couplets.mjs docs src/content
```

The script prints each hit with its line number. It exits with code 1 when it finds a hit, so you can use it in CI.

## Run the tests

```sh
node --test test.mjs
```

## Limits

The patterns are regular expressions. They do not find every couplet, and some valid sentences can match. If a valid sentence is blocked, join the counts with "and" or add the file to `NOSLOP_ALLOW`.

## License

MIT
