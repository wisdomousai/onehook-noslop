#!/usr/bin/env node
// Detect the quantifier couplet: two number phrases set in mirror
// ("Four moments, one job" / "Three signals. One job.").
//
//   node couplets.mjs <file-or-dir> [...more]     scan and list hits (exit 1 when any)
//   node couplets.mjs --hook                      Claude Code PreToolUse hook:
//                                                 reads tool JSON on stdin, exits 2
//                                                 (blocking) when new text contains one
//
// Runs on Node 18+ or Bun. No dependencies.
//
// A literal list joined with "and" instead of a comma passes ("two bistros and
// three wine bars"). That is the intended escape hatch for genuine counts.
//
// NOSLOP_ALLOW: comma-separated path fragments the hook and scanner skip, for
// example style guides that quote the construct as a banned example.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const NUM = "(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen|\\d+)"

// "one X(, up to 3 more words), one Y" with a comma, semicolon or colon hinge
const COMMA_MIRROR = new RegExp(
  `\\b${NUM}\\s+(?:[a-z][a-z'-]*\\s+){0,3}?[a-z][a-z'-]*\\s*[,;:]\\s*(?:and\\s+|or\\s+|but\\s+)?${NUM}\\b`,
  "gi",
)

// "Three signals. One job." Short mirrored sentences that both open on a number word.
const SENTENCE_MIRROR =
  /\b(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s[^.!?\n]{0,45}[.!?]\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s/g

const SELF = basename(fileURLToPath(import.meta.url))

const ALLOWED = [
  "node_modules/",
  ".next/",
  "dist/",
  ".git/",
  ...(process.env.NOSLOP_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]

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

export function scanText(text) {
  const hits = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    COMMA_MIRROR.lastIndex = 0
    let m
    while ((m = COMMA_MIRROR.exec(lines[i]))) hits.push({ line: i + 1, snippet: m[0] })
  }
  // The sentence mirror can span a line break, so run it over the whole text.
  SENTENCE_MIRROR.lastIndex = 0
  let m
  while ((m = SENTENCE_MIRROR.exec(text))) {
    const line = text.slice(0, m.index).split("\n").length
    hits.push({ line, snippet: m[0].trim() })
  }
  return hits
}

function isAllowed(path) {
  const p = path.replaceAll("\\", "/")
  return basename(p) === SELF || ALLOWED.some((a) => p.includes(a))
}

function walk(path, out) {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name.startsWith(".")) continue
      walk(join(path, name), out)
    }
  } else if (PROSE_EXT.has(extname(path)) && !isAllowed(path)) {
    out.push(path)
  }
}

async function readStdin() {
  let data = ""
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function hookMode() {
  const input = JSON.parse(await readStdin())
  const tool = input.tool_name
  const ti = input.tool_input ?? {}
  const path = ti.file_path ?? ""
  if (path && (isAllowed(path) || (extname(path) && !PROSE_EXT.has(extname(path))))) process.exit(0)

  let texts = []
  if (tool === "Write") texts = [ti.content ?? ""]
  else if (tool === "Edit") texts = [ti.new_string ?? ""]
  else if (tool === "MultiEdit") texts = (ti.edits ?? []).map((e) => e.new_string ?? "")
  const hits = texts.flatMap((t) => scanText(t))
  if (!hits.length) process.exit(0)

  const shown = hits
    .slice(0, 5)
    .map((h) => `  • "${h.snippet}"`)
    .join("\n")
  console.error(
    `Blocked: the text contains a quantifier couplet, which is banned in all prose here.\n${shown}\n` +
      `Restructure the sentence to state the point plainly. Do not mirror two number phrases, ` +
      `and do not swap in another rhetorical figure (antithesis, triad, epigram). ` +
      `A genuine literal list passes when joined with "and" instead of a comma.`,
  )
  process.exit(2)
}

function cliMode(targets) {
  if (!targets.length) {
    console.error("usage: node couplets.mjs <file-or-dir> [...more]   |   --hook")
    process.exit(1)
  }
  const files = []
  for (const t of targets) walk(t, files)
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
