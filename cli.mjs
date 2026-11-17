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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "couplets.mjs")
const PLUGIN_SRC = join(HERE, "plugin")
const SKILL = join(PLUGIN_SRC, "SKILL.md")
const MARKER = "onehook-noslop"
const VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version

// Comments only, so a fresh install skips nothing until the user adds a line.
const ALLOW_TEMPLATE = `# Paths onehook-noslop skips. One path fragment per line.
# A file is skipped when its path contains the fragment.
# Blank lines and lines starting with # are ignored.
#
# docs/style-guide.md
# imports/
`

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

function selectAgents(args, project, allowEmpty = false) {
  const i = args.indexOf("--agent")
  const raw = i >= 0 ? args[i + 1] : undefined
  if (raw) {
    const ids = raw === "all" ? Object.keys(AGENTS) : raw.split(",").map((s) => s.trim())
    const bad = ids.filter((id) => !AGENTS[id])
    if (bad.length) throw new Error(`Unknown agent: ${bad.join(", ")}. Use ${Object.keys(AGENTS).join(", ")} or all.`)
    return ids
  }
  const found = Object.keys(AGENTS).filter((id) => agentInUse(id))
  if (!found.length && !allowEmpty) {
    throw new Error(`No agent config folder found. Name the agents with --agent ${Object.keys(AGENTS).join(",")}.`)
  }
  return found
}

// The plugin lives in ~/.claude/skills. That directory alone is not a Claude
// Code install, so a machine that only has the plugin does not also get the
// settings.json hook.
function agentInUse(id) {
  const dir = AGENTS[id].userDir()
  if (!existsSync(dir)) return false
  if (id !== "claude") return true
  for (const name of readdirSync(dir)) {
    if (name !== "skills") return true
    for (const skill of readdirSync(join(dir, "skills"))) {
      if (skill !== MARKER) return true
    }
  }
  return false
}

function allowFile(project) {
  return project ? join(process.cwd(), ".onehook-noslop", "allow") : join(homedir(), ".onehook-noslop", "allow")
}

// Create the allow list for this install scope when it is missing.
// A second install leaves an existing list untouched. Uninstall does not remove it.
function ensureAllow(project, dryRun) {
  const path = allowFile(project)
  if (existsSync(path)) {
    console.log(`\nAllow list: ${path}`)
    return
  }
  if (dryRun) {
    console.log(`\nAllow list: would create ${path}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, ALLOW_TEMPLATE)
  console.log(`\nAllow list: created ${path}`)
}

// Claude Code loads a plugin from ~/.claude/skills/<name>/ when that folder
// contains .claude-plugin/plugin.json. Claude Desktop admits that same
// skills-directory plugin, so its hook runs in Code and, on recent Desktop
// versions, in Cowork and Chat. The Office add-ins do not run the hook. They
// read a skill turned on in Claude settings, which is the zip written beside
// the allow list.
function pluginDirs(project) {
  if (project) return [join(process.cwd(), ".claude", "skills", MARKER)]
  const dirs = [join(homedir(), ".claude", "skills", MARKER)]
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(join(process.env.CLAUDE_CONFIG_DIR, "skills", MARKER))
  return [...new Set(dirs.map((d) => resolve(d)))]
}

function skillZip(project) {
  const root = project ? process.cwd() : homedir()
  return join(root, ".onehook-noslop", `${MARKER}.zip`)
}

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

// Stored (uncompressed) zip. The archive root is the skill folder, which is
// the shape Claude Desktop asks for when you upload a skill.
function zipStore(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const data = Buffer.from(f.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 8) // store, no compression
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    parts.push(local, name, data)
    central.push(cen, name)
    offset += local.length + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, end])
}

function installClaudePlugin(project, dryRun) {
  const dirs = pluginDirs(project)
  const zip = skillZip(project)
  if (dryRun) {
    for (const dir of dirs) console.log(`\nClaude plugin: would write ${dir}`)
    console.log(`Skill archive: would write ${zip}`)
    return
  }
  const manifest = JSON.parse(readFileSync(join(PLUGIN_SRC, ".claude-plugin", "plugin.json"), "utf8"))
  manifest.version = VERSION
  for (const dir of dirs) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
    mkdirSync(join(dir, "hooks"), { recursive: true })
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    copyFileSync(join(PLUGIN_SRC, "hooks", "hooks.json"), join(dir, "hooks", "hooks.json"))
    copyFileSync(SKILL, join(dir, "SKILL.md"))
    copyFileSync(SCRIPT, join(dir, "couplets.mjs"))
    writeFileSync(join(dir, "version.json"), `${JSON.stringify({ version: VERSION })}\n`)
    console.log(`\nClaude plugin: ${dir}`)
  }
  mkdirSync(dirname(zip), { recursive: true })
  const skill = readFileSync(SKILL)
  writeFileSync(zip, zipStore([{ name: `${MARKER}/SKILL.md`, data: skill }]))
  console.log(`Skill archive: ${zip}`)
  console.log("  Claude Code and Claude Desktop load the plugin from the skills folder.")
  console.log("  Upload the archive in Claude Desktop: Customize, Skills, Create skill, Upload a skill.")
  console.log("  The Word, Excel, PowerPoint, and Outlook add-ins then use that skill. They do not run the file hook.")
}

function removeClaudePlugin(project) {
  for (const dir of pluginDirs(project)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  rmSync(skillZip(project), { force: true })
  console.log("Claude plugin: removed.")
}

function install(args) {
  const project = args.includes("--project")
  const dryRun = args.includes("--dry-run")
  const targets = selectAgents(args, project, true).map((id) => locate(id, project))
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
  ensureAllow(project, dryRun)
  installClaudePlugin(project, dryRun)
}

function uninstall(args) {
  const project = args.includes("--project")
  for (const t of selectAgents(args, project, true).map((id) => locate(id, project))) {
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
  removeClaudePlugin(project)
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
