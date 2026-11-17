#!/usr/bin/env node
// Detect the quantifier couplet: two quantity phrases set in mirror
// ("Four moments, one job", "One app, many teams", "Five rooms, no waiting",
// "Three signals. One job.").
//
//   node couplets.mjs <file-or-dir> [...more]   scan and list hits (exit 1 when any)
//   node couplets.mjs --hook                    pre-edit hook: reads the agent's tool
//                                               JSON on stdin and blocks the edit when
//                                               the new text contains a couplet
//
// The hook understands the input of Claude Code, OpenAI Codex, Cursor, Gemini CLI
// and GitHub Copilot CLI, and answers each in the form that agent expects.
// Runs on Node 18+ or Bun. No dependencies.
//
// A literal list joined with "and" instead of a comma passes ("two bistros and
// three wine bars"). That is the intended escape hatch for genuine counts.
//
// Skipped paths, merged, in addition to node_modules/, .next/, dist/ and .git/:
//   ~/.onehook-noslop/allow                         global, every repo
//   <repo>/.onehook-noslop/allow                    local, travels with the repo
//   an allow file sitting next to this script       per-install list
//   NOSLOP_ALLOW                                     comma-separated fragments
// One fragment per line. A file is skipped when its path contains the fragment.
// Lines that are empty or start with # are ignored.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Exact quantities. At least one side of a couplet must be one of these.
const NUMBER =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand|million|\\d+"
// Vague quantities that can sit on the other side ("one app, many teams").
const VAGUE = "many|few|no|zero|several|countless|endless|infinite"
const QUANT = `(?:${NUMBER}|${VAGUE})`
const IS_NUMBER = new RegExp(`^(?:${NUMBER})$`, "i")

// "one X(, up to 3 more words), many Y" with a comma, semicolon or colon hinge
const COMMA_MIRROR = new RegExp(
  `\\b(${QUANT})\\s+(?:[a-z][a-z'-]*\\s+){0,3}?[a-z][a-z'-]*\\s*[,;:]\\s*(?:and\\s+|or\\s+|but\\s+)?(${QUANT})\\b`,
  "gi",
)

// "Three signals. One job." Short mirrored sentences that both open on a quantity.
const SENTENCE_MIRROR = new RegExp(
  `(?<![\\w'-])(${QUANT})\\s[^.!?\\n]{0,45}[.!?]\\s+(${QUANT})\\s`,
  "gi",
)

const SELF = basename(fileURLToPath(import.meta.url))
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const BUILTIN_ALLOW = ["node_modules/", ".next/", "dist/", ".git/"]

export function globalAllowPath() {
  return join(homedir(), ".onehook-noslop", "allow")
}

// One fragment per line. Blank lines and lines starting with # are comments.
export function allowEntries(text) {
  const out = []
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    out.push(trimmed)
  }
  return out
}

// Nearest <dir>/.onehook-noslop/allow above start, stopping before the home
// directory so the global file is not also treated as a project file.
export function findProjectAllow(start) {
  if (!start) return null
  let dir
  try {
    dir = statSync(start).isDirectory() ? resolve(start) : dirname(resolve(start))
  } catch {
    dir = dirname(resolve(start))
  }
  const home = resolve(homedir())
  while (resolve(dir) !== home) {
    const candidate = join(dir, ".onehook-noslop", "allow")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readEntries(path) {
  try {
    return allowEntries(readFileSync(path, "utf8"))
  } catch {
    return []
  }
}

// Built-ins, the global file, the nearest project file, a list beside this
// script, and NOSLOP_ALLOW. starts are extra directories or file paths to
// search upward from (edited files, scan targets).
export function allowPatterns(starts = []) {
  const files = []
  const add = (path) => {
    if (!path || !existsSync(path)) return
    const abs = resolve(path)
    if (!files.includes(abs)) files.push(abs)
  }
  add(globalAllowPath())
  add(join(SCRIPT_DIR, "allow"))
  for (const start of [process.cwd(), SCRIPT_DIR, ...starts]) add(findProjectAllow(start))
  const patterns = [...BUILTIN_ALLOW]
  for (const file of files) patterns.push(...readEntries(file))
  for (const piece of (process.env.NOSLOP_ALLOW ?? "").split(",")) {
    const trimmed = piece.trim()
    if (trimmed) patterns.push(trimmed)
  }
  return patterns
}

const PROSE_EXT = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".json",
  ".html",
  ".vtt",
])

function isCouplet(m) {
  return IS_NUMBER.test(m[1]) || IS_NUMBER.test(m[2])
}

function startsSentence(text, index) {
  const before = text.slice(0, index).trimEnd()
  return before === "" || /[.!?:#>*\-\n"'(]$/.test(before)
}

export function scanText(text) {
  const hits = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(COMMA_MIRROR)) {
      if (isCouplet(m)) hits.push({ line: i + 1, snippet: m[0] })
    }
  }
  // The sentence mirror can span a line break, so run it over the whole text.
  for (const m of text.matchAll(SENTENCE_MIRROR)) {
    if (!isCouplet(m) || !startsSentence(text, m.index)) continue
    const line = text.slice(0, m.index).split("\n").length
    hits.push({ line, snippet: m[0].trim() })
  }
  return hits
}

function pathAllowed(path, patterns) {
  const p = path.replaceAll("\\", "/")
  return basename(p) === SELF || patterns.some((a) => p.includes(a))
}

function isProsePath(path, patterns) {
  if (!path) return true // unknown target: scan it
  if (pathAllowed(path, patterns)) return false
  const ext = extname(path)
  return !ext || PROSE_EXT.has(ext)
}

function walk(path, out, patterns) {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name.startsWith(".")) continue
      walk(join(path, name), out, patterns)
    }
  } else if (PROSE_EXT.has(extname(path)) && !pathAllowed(path, patterns)) {
    out.push(path)
  }
}

// ---------------------------------------------------------------------------
// Hook input

const PATCH_MARKER = /^\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)/m

// Codex and Copilot apply_patch: split the patch per file and keep the added lines.
export function parsePatch(patch) {
  const edits = []
  let current = null
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (header) {
      current = header[1] === "Delete" ? null : { path: header[2].trim(), lines: [] }
      if (current) edits.push(current)
      continue
    }
    if (line.startsWith("*** ")) continue // Move to, End Patch, End of File
    if (current && line.startsWith("+")) current.lines.push(line.slice(1))
  }
  return edits.map((e) => ({ path: e.path, text: e.lines.join("\n") }))
}

const PATH_KEYS = ["file_path", "path", "filePath", "target_file", "absolute_path"]
const TEXT_KEYS = [
  "content",
  "contents",
  "file_text",
  "new_string",
  "newString",
  "new_str",
  "streamContent",
  "text",
  "replacement",
  "code_edit",
]

function firstString(obj, keys) {
  for (const k of keys) if (typeof obj?.[k] === "string") return obj[k]
  return undefined
}

function parseArgs(args) {
  if (args && typeof args === "object") return args
  if (typeof args !== "string") return {}
  if (PATCH_MARKER.test(args)) return { command: args, __patch: true }
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function detectAgent(event) {
  if (event.toolName !== undefined || event.toolArgs !== undefined) return "copilot"
  if (event.cursor_version !== undefined || event.conversation_id !== undefined) return "cursor"
  if (event.hook_event_name === "BeforeTool") return "gemini"
  if (event.tool_name === "apply_patch") return "codex"
  return "claude"
}

// Returns [{ path, text }] for the text the tool is about to write.
export function extractEdits(event) {
  const name = event.tool_name ?? event.toolName ?? ""
  const input = parseArgs(event.tool_input ?? event.toolArgs)

  const patch = typeof input.command === "string" ? input.command : typeof input.patch === "string" ? input.patch : ""
  if ((name === "apply_patch" || input.__patch) && PATCH_MARKER.test(patch)) return parsePatch(patch)

  const path = firstString(input, PATH_KEYS) ?? (typeof event.file_path === "string" ? event.file_path : "")
  const texts = []
  const single = firstString(input, TEXT_KEYS)
  if (single !== undefined) texts.push(single)
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const t = firstString(e, TEXT_KEYS)
      if (t !== undefined) texts.push(t)
    }
  }
  return texts.map((text) => ({ path, text }))
}

const ADVICE =
  "Restructure the sentence to state the point plainly. Do not mirror two quantity phrases, " +
  "and do not swap in another rhetorical figure (antithesis, triad, epigram). " +
  'A genuine literal list passes when joined with "and" instead of a comma.'

function respond(agent, hits) {
  const shown = hits
    .slice(0, 5)
    .map((h) => `  • "${h.snippet}"`)
    .join("\n")
  const message = `Blocked: the text contains a quantifier couplet, which is banned in all prose here.\n${shown}\n${ADVICE}`

  if (agent === "cursor") {
    process.stdout.write(JSON.stringify({ permission: "deny", user_message: message, agent_message: message }))
    process.exit(0)
  }
  if (agent === "copilot") {
    process.stdout.write(JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message }))
  }
  // Claude Code, Codex, Gemini CLI and Copilot all treat exit 2 as a block and
  // pass stderr to the model.
  console.error(message)
  process.exit(2)
}

async function readStdin() {
  let data = ""
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function hookMode() {
  let event
  let edits
  try {
    event = JSON.parse(await readStdin())
    edits = extractEdits(event)
  } catch {
    process.exit(0) // never break a turn on input we do not understand
  }
  const patterns = allowPatterns(edits.map((e) => e.path).filter(Boolean))
  const hits = edits.filter((e) => isProsePath(e.path, patterns)).flatMap((e) => scanText(e.text))
  if (!hits.length) process.exit(0)
  respond(detectAgent(event), hits)
}

function cliMode(targets) {
  if (!targets.length) {
    console.error("usage: node couplets.mjs <file-or-dir> [...more]   |   --hook")
    process.exit(1)
  }
  const patterns = allowPatterns(targets)
  const files = []
  for (const t of targets) walk(t, files, patterns)
  let total = 0
  for (const f of files) {
    const hits = scanText(readFileSync(f, "utf8"))
    if (!hits.length) continue
    total += hits.length
    console.log(`\n${relative(process.cwd(), f)}`)
    for (const h of hits) console.log(`  ${h.line}: "${h.snippet}"`)
  }
  console.log(`\n${total} couplet hit(s) across ${files.length} scanned file(s).`)
  if (total > 0) process.exit(1)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (process.argv[2] === "--hook") await hookMode()
else if (isMain) cliMode(process.argv.slice(2))
