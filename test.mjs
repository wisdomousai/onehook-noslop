import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { allowEntries, extractEdits, scanText } from "./couplets.mjs"

const SCRIPT = fileURLToPath(new URL("./couplets.mjs", import.meta.url))
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "noslop-hook-home-"))

const blocked = [
  "Four moments, one job",
  "Three signals. One job.",
  "Two kinds of proposal; one decision",
  "5 screens, 1 flow",
  "One app, many teams",
  "Five rooms, no waiting",
  "Many voices, one mission",
  "Zero config, one command",
  "Three signals. No noise.",
]

const passed = [
  "two bistros and three wine bars",
  "The page lists three options.",
  "Version 2 adds export to CSV.",
  "No meetings, no fluff",
  "Many people, few answers",
  "It has no tests. Many files lack types.",
]

for (const s of blocked) test(`flags: ${s}`, () => assert.ok(scanText(s).length > 0))
for (const s of passed) test(`passes: ${s}`, () => assert.equal(scanText(s).length, 0))

function runHook(input, { cwd, home, env } = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--hook"], {
    cwd,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: home ?? ISOLATED_HOME, NOSLOP_ALLOW: "", ...env },
  })
}

const BAD = "## Three signals. One job.\n"

test("Claude Code Write is blocked with exit 2", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "README.md", content: BAD } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /quantifier couplet/)
})

test("Claude Code Edit with plain text passes", () => {
  const r = runHook({ tool_name: "Edit", tool_input: { file_path: "README.md", new_string: "## Install" } })
  assert.equal(r.status, 0)
})

test("non-prose files are ignored", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "main.py", content: BAD } })
  assert.equal(r.status, 0)
})

// Payload shape captured from codex-cli 0.169.0.
const codexPatch = (file, added) =>
  `*** Begin Patch\n*** Update File: /repo/notes.md\n@@\n-hello\n+ok\n*** Add File: ${file}\n+${added}\n*** End Patch`

test("Codex apply_patch is split per file and only added lines are scanned", () => {
  const edits = extractEdits({ tool_name: "apply_patch", tool_input: { command: codexPatch("/repo/new.md", "x") } })
  assert.deepEqual(edits, [
    { path: "/repo/notes.md", text: "ok" },
    { path: "/repo/new.md", text: "x" },
  ])
})

test("Codex apply_patch with a couplet is blocked", () => {
  const r = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: codexPatch("/repo/new.md", "One app, many teams") },
  })
  assert.equal(r.status, 2)
})

test("Codex apply_patch into a non-prose file passes", () => {
  const r = runHook({ tool_name: "apply_patch", tool_input: { command: codexPatch("/repo/a.py", "One app, many teams") } })
  assert.equal(r.status, 0)
})

test("Codex removed lines are not scanned", () => {
  const patch = "*** Begin Patch\n*** Update File: /repo/a.md\n@@\n-One app, many teams\n+Plain text\n*** End Patch"
  assert.equal(runHook({ tool_name: "apply_patch", tool_input: { command: patch } }).status, 0)
})

test("Cursor gets a JSON deny on stdout", () => {
  const r = runHook({
    conversation_id: "c1",
    cursor_version: "1.0",
    hook_event_name: "preToolUse",
    tool_name: "Write",
    tool_input: { path: "/p/a.md", contents: BAD },
  })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).permission, "deny")
})

test("Gemini CLI replace is blocked with exit 2", () => {
  const r = runHook({
    hook_event_name: "BeforeTool",
    tool_name: "replace",
    tool_input: { file_path: "/p/a.md", old_string: "x", new_string: BAD },
  })
  assert.equal(r.status, 2)
})

test("Copilot edit with JSON-string toolArgs is blocked", () => {
  const r = runHook({ toolName: "edit", toolArgs: JSON.stringify({ path: "/p/a.md", old_str: "x", new_str: BAD }) })
  assert.equal(r.status, 2)
  assert.equal(JSON.parse(r.stdout).permissionDecision, "deny")
})

test("Copilot apply_patch with raw patch toolArgs is blocked", () => {
  const r = runHook({ toolName: "apply_patch", toolArgs: codexPatch("/p/b.md", "Five rooms, no waiting") })
  assert.equal(r.status, 2)
})

test("shell and read tools pass", () => {
  assert.equal(runHook({ tool_name: "Bash", tool_input: { command: "echo 'Two layers, one rule'" } }).status, 0)
  assert.equal(runHook({ conversation_id: "c", tool_name: "Read", tool_input: { path: "a.md" } }).status, 0)
})

test("malformed input never blocks", () => {
  assert.equal(runHook("not json").status, 0)
})

test("allow file comments and blank lines are ignored", () => {
  assert.deepEqual(allowEntries("# docs/style.md\n\n  imports/ \nnotes.md\n"), ["imports/", "notes.md"])
})

test("a project allow list skips that file and still blocks others", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-proj-allow-"))
  const home = mkdtempSync(join(tmpdir(), "noslop-proj-allow-home-"))
  mkdirSync(join(dir, ".onehook-noslop"), { recursive: true })
  writeFileSync(join(dir, ".onehook-noslop", "allow"), "# keep\nstyle-guide.md\n")
  const allowed = runHook(
    { tool_name: "Write", tool_input: { file_path: join(dir, "docs", "style-guide.md"), content: BAD } },
    { cwd: dir, home },
  )
  assert.equal(allowed.status, 0)
  const blocked = runHook(
    { tool_name: "Write", tool_input: { file_path: join(dir, "docs", "page.md"), content: BAD } },
    { cwd: dir, home },
  )
  assert.equal(blocked.status, 2)
})

test("a global allow list applies in a repo that has no local list", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-glob-allow-"))
  const home = mkdtempSync(join(tmpdir(), "noslop-glob-allow-home-"))
  mkdirSync(join(home, ".onehook-noslop"), { recursive: true })
  writeFileSync(join(home, ".onehook-noslop", "allow"), "glossary.md\n")
  const allowed = runHook(
    { tool_name: "Write", tool_input: { file_path: join(dir, "glossary.md"), content: BAD } },
    { cwd: dir, home },
  )
  assert.equal(allowed.status, 0)
  const blocked = runHook(
    { tool_name: "Write", tool_input: { file_path: join(dir, "page.md"), content: BAD } },
    { cwd: dir, home },
  )
  assert.equal(blocked.status, 2)
})

test("NOSLOP_ALLOW still skips a matching path", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-env-allow-"))
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: join(dir, "notes.md"), content: BAD } },
    { cwd: dir, env: { NOSLOP_ALLOW: "notes.md" } },
  )
  assert.equal(r.status, 0)
})

test("scan skips a path listed in the project allow file", () => {
  const dir = mkdtempSync(join(tmpdir(), "noslop-scan-"))
  const home = mkdtempSync(join(tmpdir(), "noslop-scan-home-"))
  mkdirSync(join(dir, ".onehook-noslop"), { recursive: true })
  writeFileSync(join(dir, ".onehook-noslop", "allow"), "quoted.md\n")
  writeFileSync(join(dir, "quoted.md"), "One app, many teams\n")
  writeFileSync(join(dir, "other.md"), "One app, many teams\n")
  const r = spawnSync(process.execPath, [SCRIPT, dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HOME: home, NOSLOP_ALLOW: "" },
  })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /other\.md/)
  assert.doesNotMatch(r.stdout, /quoted\.md/)
})
