#!/usr/bin/env node
// onehook-noslop command line.
//
//   onehook-noslop install   [--project] [--agent <list>] [--dry-run]
//   onehook-noslop uninstall [--project] [--agent <list>]
//   onehook-noslop scan <file-or-dir> [...more]
//   onehook-noslop hook
//
// <list> is a comma-separated list of: claude, codex, cursor, gemini, copilot, all.
// Without --agent, the command uses every agent whose user config folder exists.
//
// For each agent the hook script is copied next to that agent's config, so each
// edit runs a local file and needs no network access.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "couplets.mjs")
const MARKER = "onehook-noslop"

const home = (envVar, name) => process.env[envVar] || join(homedir(), name)

// kind "nested": { hooks: { <event>: [ { matcher, hooks: [ {type, command} ] } ] } }
// kind "flat":   { version: 1, hooks: { <event>: [ {command} ] } }      (Cursor)
// kind "file":   a whole JSON file that belongs to this hook               (Copilot)
const AGENTS = {
  claude: {
    name: "Claude Code",
    userDir: () => home("CLAUDE_CONFIG_DIR", ".claude"),
    projectDir: ".claude",
    configFile: "settings.json",
    kind: "nested",
    event: "PreToolUse",
    matcher: "Write|Edit|MultiEdit",
    projectCommand: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${MARKER}/couplets.mjs" --hook`,
    reload: "Restart Claude Code or open /hooks.",
  },
  codex: {
    name: "Codex",
    userDir: () => home("CODEX_HOME", ".codex"),
    projectDir: ".codex",
    configFile: "hooks.json",
    kind: "nested",
    event: "PreToolUse",
    matcher: "^(apply_patch|Edit|Write)$",
    extra: { timeout: 10, statusMessage: "Checking prose for quantifier couplets" },
    projectCommand: `node "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/hooks/${MARKER}/couplets.mjs" --hook`,
    reload: "Open /hooks in Codex and trust the new hook. Codex skips untrusted hooks.",
  },
  cursor: {
    name: "Cursor",
    userDir: () => join(homedir(), ".cursor"),
    projectDir: ".cursor",
    configFile: "hooks.json",
    kind: "flat",
    event: "preToolUse",
    extra: { timeout: 10 },
    projectCommand: `node .cursor/hooks/${MARKER}/couplets.mjs --hook`,
    reload: "Restart Cursor.",
  },
  gemini: {
    name: "Gemini CLI",
    userDir: () => join(homedir(), ".gemini"),
    projectDir: ".gemini",
    configFile: "settings.json",
    kind: "nested",
    event: "BeforeTool",
    matcher: "write_file|replace",
    extra: { name: MARKER, timeout: 10000 },
    projectCommand: `node "$GEMINI_PROJECT_DIR/.gemini/hooks/${MARKER}/couplets.mjs" --hook`,
    reload: "Restart Gemini CLI.",
  },
  copilot: {
    name: "GitHub Copilot CLI",
    userDir: () => home("COPILOT_HOME", ".copilot"),
    projectDir: ".github",
    configFile: `hooks/${MARKER}.json`,
    kind: "file",
    event: "preToolUse",
    projectCommand: `node .github/hooks/${MARKER}/couplets.mjs --hook`,
    reload: "Restart Copilot CLI.",
  },
}

function locate(id, project) {
  const a = AGENTS[id]
  const base = project ? join(process.cwd(), a.projectDir) : a.userDir()
  const hookDir = join(base, "hooks", MARKER)
  const command = project ? a.projectCommand : `node "${join(hookDir, "couplets.mjs")}" --hook`
  return { ...a, id, base, hookDir, command, config: join(base, a.configFile) }
}

function readJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`Cannot parse ${path}: ${e.message}. Fix the file and run the command again.`)
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${MARKER}`)
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

const ours = (h) => typeof h?.command === "string" && h.command.includes(MARKER)

// Remove our entries from a config object. Returns true when something was removed.
function strip(t, cfg) {
  const list = cfg.hooks?.[t.event]
  if (!Array.isArray(list)) return false
  let removed = false
  let kept
  if (t.kind === "flat") {
    kept = list.filter((h) => !(ours(h) && (removed = true)))
  } else {
    kept = []
    for (const g of list) {
      const hooks = (g.hooks ?? []).filter((h) => !(ours(h) && (removed = true)))
      if (hooks.length) kept.push({ ...g, hooks })
    }
  }
  if (kept.length) cfg.hooks[t.event] = kept
  else delete cfg.hooks[t.event]
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks
  return removed
}

function planInstall(t) {
  if (t.kind === "file") {
    return {
      version: 1,
      hooks: { preToolUse: [{ type: "command", bash: t.command, command: t.command, timeoutSec: 10 }] },
    }
  }
  const cfg = readJson(t.config)
  strip(t, cfg)
  cfg.hooks ??= {}
  cfg.hooks[t.event] ??= []
  const hook = { type: "command", command: t.command, ...t.extra }
  if (t.kind === "flat") {
    cfg.version ??= 1
    const { type, ...flat } = hook
    cfg.hooks[t.event].push(flat)
  } else {
    cfg.hooks[t.event].push({ matcher: t.matcher, hooks: [hook] })
  }
  return cfg
}

function selectAgents(args, project) {
  const i = args.indexOf("--agent")
  const raw = i >= 0 ? args[i + 1] : undefined
  if (raw) {
    const ids = raw === "all" ? Object.keys(AGENTS) : raw.split(",").map((s) => s.trim())
    const bad = ids.filter((id) => !AGENTS[id])
    if (bad.length) throw new Error(`Unknown agent: ${bad.join(", ")}. Use ${Object.keys(AGENTS).join(", ")} or all.`)
    return ids
  }
  const found = Object.keys(AGENTS).filter((id) => existsSync(AGENTS[id].userDir()))
  if (!found.length) {
    throw new Error(`No agent config folder found. Name the agents with --agent ${Object.keys(AGENTS).join(",")}.`)
  }
  return found
}

function install(args) {
  const project = args.includes("--project")
  const dryRun = args.includes("--dry-run")
  const targets = selectAgents(args, project).map((id) => locate(id, project))
  const plans = targets.map((t) => [t, planInstall(t)]) // parse every config before writing any
  for (const [t, cfg] of plans) {
    if (dryRun) {
      console.log(`\n${t.name}: would copy couplets.mjs to ${t.hookDir}`)
      console.log(`${t.name}: would write ${t.config}:\n${JSON.stringify(cfg, null, 2)}`)
      continue
    }
    mkdirSync(t.hookDir, { recursive: true })
    copyFileSync(SCRIPT, join(t.hookDir, "couplets.mjs"))
    writeJson(t.config, cfg)
    console.log(`\n${t.name}: installed.`)
    console.log(`  Script: ${join(t.hookDir, "couplets.mjs")}`)
    console.log(`  Config: ${t.config}`)
    console.log(`  ${t.reload}`)
  }
}

function uninstall(args) {
  const project = args.includes("--project")
  for (const t of selectAgents(args, project).map((id) => locate(id, project))) {
    let removed = false
    if (t.kind === "file") {
      removed = existsSync(t.config)
      rmSync(t.config, { force: true })
    } else {
      const cfg = readJson(t.config)
      removed = strip(t, cfg)
      if (removed) writeJson(t.config, cfg)
    }
    if (existsSync(t.hookDir)) rmSync(t.hookDir, { recursive: true, force: true })
    console.log(`${t.name}: ${removed ? `removed from ${t.config}` : "no hook found"}.`)
  }
}

function passthrough(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: "inherit" })
  process.exit(r.status ?? 1)
}

function usage(code) {
  console.log(`usage:
  onehook-noslop install   [--project] [--agent <list>] [--dry-run]
  onehook-noslop uninstall [--project] [--agent <list>]
  onehook-noslop scan <file-or-dir> [...more]
  onehook-noslop hook

<list>: comma-separated ${Object.keys(AGENTS).join(", ")}, or all.
Without --agent: every agent whose user config folder exists.`)
  process.exit(code)
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === "install") install(rest)
  else if (cmd === "uninstall") uninstall(rest)
  else if (cmd === "scan") passthrough(rest)
  else if (cmd === "hook" || cmd === "--hook") passthrough(["--hook"])
  else if (cmd === "help" || cmd === "--help" || cmd === "-h") usage(0)
  else usage(1)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
