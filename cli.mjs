#!/usr/bin/env node
// onehook-noslop command line.
//
//   onehook-noslop install [--project] [--dry-run]   add the hook to Claude Code settings
//   onehook-noslop uninstall [--project]             remove the hook from Claude Code settings
//   onehook-noslop scan <file-or-dir> [...more]      list couplets in existing files
//   onehook-noslop hook                              run as a PreToolUse hook (stdin JSON)
//
// Global install writes to $CLAUDE_CONFIG_DIR or ~/.claude. Project install
// writes to .claude/ in the current directory. In both cases the hook script is
// copied next to the settings file, so each edit runs a local file and needs no
// network access.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "couplets.mjs")
const MARKER = "onehook-noslop"
const MATCHER = "Write|Edit|MultiEdit"

function target(project) {
  if (project) {
    const dir = join(process.cwd(), ".claude")
    return {
      label: "project",
      settings: join(dir, "settings.json"),
      hookDir: join(dir, "hooks", MARKER),
      command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${MARKER}/couplets.mjs" --hook`,
    }
  }
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  const defaultDir = !process.env.CLAUDE_CONFIG_DIR
  return {
    label: "global",
    settings: join(dir, "settings.json"),
    hookDir: join(dir, "hooks", MARKER),
    command: defaultDir
      ? `node "$HOME/.claude/hooks/${MARKER}/couplets.mjs" --hook`
      : `node "${join(dir, "hooks", MARKER, "couplets.mjs")}" --hook`,
  }
}

function readSettings(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (e) {
    console.error(`Cannot parse ${path}: ${e.message}\nFix the file and run the command again.`)
    process.exit(1)
  }
}

function isOurs(h) {
  return typeof h?.command === "string" && h.command.includes(MARKER)
}

function removeOurs(settings) {
  const groups = settings.hooks?.PreToolUse
  if (!Array.isArray(groups)) return false
  let removed = false
  const kept = []
  for (const g of groups) {
    const hooks = (g.hooks ?? []).filter((h) => {
      if (isOurs(h)) removed = true
      return !isOurs(h)
    })
    if (hooks.length) kept.push({ ...g, hooks })
  }
  if (kept.length) settings.hooks.PreToolUse = kept
  else delete settings.hooks.PreToolUse
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  return removed
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${MARKER}`)
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

function install(args) {
  const t = target(args.includes("--project"))
  const dryRun = args.includes("--dry-run")
  const settings = readSettings(t.settings)
  removeOurs(settings)
  settings.hooks ??= {}
  settings.hooks.PreToolUse ??= []
  settings.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [{ type: "command", command: t.command }] })

  if (dryRun) {
    console.log(`Would copy couplets.mjs to ${t.hookDir}`)
    console.log(`Would write ${t.settings}:\n${JSON.stringify(settings, null, 2)}`)
    return
  }
  mkdirSync(t.hookDir, { recursive: true })
  copyFileSync(SCRIPT, join(t.hookDir, "couplets.mjs"))
  writeSettings(t.settings, settings)
  console.log(`Installed the ${t.label} hook.`)
  console.log(`  Script:   ${join(t.hookDir, "couplets.mjs")}`)
  console.log(`  Settings: ${t.settings} (backup: ${t.settings}.bak-${MARKER})`)
  console.log("Restart Claude Code or open /hooks to load it.")
}

function uninstall(args) {
  const t = target(args.includes("--project"))
  const settings = readSettings(t.settings)
  const removed = removeOurs(settings)
  if (removed) writeSettings(t.settings, settings)
  if (existsSync(t.hookDir)) rmSync(t.hookDir, { recursive: true, force: true })
  console.log(removed ? `Removed the ${t.label} hook from ${t.settings}.` : `No ${t.label} hook found in ${t.settings}.`)
}

function passthrough(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: "inherit" })
  process.exit(r.status ?? 1)
}

function usage(code) {
  console.log(`usage:
  onehook-noslop install [--project] [--dry-run]
  onehook-noslop uninstall [--project]
  onehook-noslop scan <file-or-dir> [...more]
  onehook-noslop hook`)
  process.exit(code)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === "install") install(rest)
else if (cmd === "uninstall") uninstall(rest)
else if (cmd === "scan") passthrough(rest)
else if (cmd === "hook" || cmd === "--hook") passthrough(["--hook"])
else if (cmd === "help" || cmd === "--help" || cmd === "-h") usage(0)
else usage(1)
