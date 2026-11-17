import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { scanText } from "./couplets.mjs"

const blocked = [
  "Four moments, one job",
  "Three signals. One job.",
  "Two kinds of proposal; one decision",
  "5 screens, 1 flow",
]

const passed = [
  "two bistros and three wine bars",
  "The page lists three options.",
  "Version 2 adds export to CSV.",
]

for (const s of blocked) test(`flags: ${s}`, () => assert.ok(scanText(s).length > 0))
for (const s of passed) test(`passes: ${s}`, () => assert.equal(scanText(s).length, 0))

function runHook(input) {
  return spawnSync(process.execPath, ["couplets.mjs", "--hook"], {
    input: JSON.stringify(input),
    encoding: "utf8",
  })
}

test("hook blocks a Write with a couplet", () => {
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: "README.md", content: "## Three signals. One job.\n" },
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /quantifier couplet/)
})

test("hook allows plain text", () => {
  const r = runHook({
    tool_name: "Edit",
    tool_input: { file_path: "README.md", new_string: "## Install" },
  })
  assert.equal(r.status, 0)
})

test("hook ignores non-prose files", () => {
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: "main.py", content: "# Four moments, one job" },
  })
  assert.equal(r.status, 0)
})
