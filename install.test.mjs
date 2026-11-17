import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url))

function run(args, { cwd, home }) {
  const env = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  delete env.COPILOT_HOME
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" })
}

const json = (p) => JSON.parse(readFileSync(p, "utf8"))
const commands = (cfg, event) =>
  (cfg.hooks?.[event] ?? []).flatMap((g) => (g.hooks ? g.hooks.map((h) => h.command) : [g.command]))
const ourCount = (cfg, event) => commands(cfg, event).filter((c) => c.includes("onehook-noslop")).length

test("default install picks agents whose folders exist and keeps other hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "noslop-home-"))
  mkdirSync(join(home, ".codex"))
  mkdirSync(join(home, ".cursor"))
  const other = { matcher: "^Bash$", hooks: [{ type: "command", command: "python3 guard.py" }] }
  writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [other] } }))

  const r = run(["install"], { cwd: home, home })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(run(["install"], { cwd: home, home }).status, 0)

  const codex = json(join(home, ".codex", "hooks.json"))
  assert.deepEqual(codex.hooks.PreToolUse[0], other)
  assert.equal(ourCount(codex, "PreToolUse"), 1)
  assert.ok(existsSync(join(home, ".codex", "hooks", "onehook-noslop", "couplets.mjs")))
  assert.ok(existsSync(join(home, ".onehook-noslop", "allow")))

  const cursor = json(join(home, ".cursor", "hooks.json"))
  assert.equal(cursor.version, 1)
  assert.equal(ourCount(cursor, "preToolUse"), 1)

  assert.ok(!existsSync(join(home, ".claude", "settings.json")), "claude settings stay absent when that folder did not exist")
  const plugin = join(home, ".claude", "skills", "onehook-noslop")
  assert.equal(json(join(plugin, ".claude-plugin", "plugin.json")).name, "onehook-noslop")
  assert.match(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"), /CLAUDE_PLUGIN_ROOT/)
  assert.ok(existsSync(join(plugin, "couplets.mjs")))
  assert.match(readFileSync(join(plugin, "SKILL.md"), "utf8"), /name: onehook-noslop/)
  assert.ok(readFileSync(join(home, ".onehook-noslop", "onehook-noslop.zip")).includes(Buffer.from("onehook-noslop/SKILL.md")))

  assert.equal(run(["uninstall"], { cwd: home, home }).status, 0)
  assert.deepEqual(json(join(home, ".codex", "hooks.json")).hooks.PreToolUse, [other])
  assert.deepEqual(json(join(home, ".cursor", "hooks.json")), { version: 1 })
  assert.ok(!existsSync(join(home, ".codex", "hooks", "onehook-noslop")))
  assert.ok(existsSync(join(home, ".onehook-noslop", "allow")), "uninstall keeps the allow list")
  assert.ok(!existsSync(join(home, ".claude", "skills", "onehook-noslop")))
  assert.ok(!existsSync(join(home, ".onehook-noslop", "onehook-noslop.zip")))
})

test("--agent all --project writes every project config, and the copied hook blocks", () => {
  const home = mkdtempSync(join(tmpdir(), "noslop-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "noslop-proj-"))
  const r = run(["install", "--project", "--agent", "all"], { cwd, home })
  assert.equal(r.status, 0, r.stderr)

  assert.equal(ourCount(json(join(cwd, ".claude", "settings.json")), "PreToolUse"), 1)
  assert.equal(ourCount(json(join(cwd, ".codex", "hooks.json")), "PreToolUse"), 1)
  assert.equal(ourCount(json(join(cwd, ".cursor", "hooks.json")), "preToolUse"), 1)
  assert.equal(ourCount(json(join(cwd, ".gemini", "settings.json")), "BeforeTool"), 1)
  assert.equal(ourCount(json(join(cwd, ".github", "hooks", "onehook-noslop.json")), "preToolUse"), 1)
  assert.ok(existsSync(join(cwd, ".onehook-noslop", "allow")))
  assert.ok(existsSync(join(cwd, ".claude", "skills", "onehook-noslop", "SKILL.md")))
  assert.ok(existsSync(join(cwd, ".onehook-noslop", "onehook-noslop.zip")))
  assert.ok(!existsSync(join(home, ".onehook-noslop")), "a project install does not write the global list")
  assert.ok(!existsSync(join(home, ".claude")), "a project install does not write the global plugin")

  const script = join(cwd, ".codex", "hooks", "onehook-noslop", "couplets.mjs")
  const hook = spawnSync(process.execPath, [script, "--hook"], {
    cwd,
    input: JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: a.md\n+One app, many teams\n*** End Patch" } }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, NOSLOP_ALLOW: "" },
  })
  assert.equal(hook.status, 2)

  assert.equal(run(["uninstall", "--project", "--agent", "all"], { cwd, home }).status, 0)
  assert.ok(!existsSync(join(cwd, ".github", "hooks", "onehook-noslop.json")))
  assert.ok(!existsSync(join(cwd, ".claude", "hooks", "onehook-noslop")))
  assert.ok(existsSync(join(cwd, ".onehook-noslop", "allow")), "uninstall keeps the repo allow list")
  assert.ok(!existsSync(join(cwd, ".claude", "skills", "onehook-noslop")))
  assert.ok(!existsSync(join(cwd, ".onehook-noslop", "onehook-noslop.zip")))
})

test("a second project install keeps an edited allow list", () => {
  const home = mkdtempSync(join(tmpdir(), "noslop-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "noslop-proj-"))
  assert.equal(run(["install", "--project", "--agent", "cursor"], { cwd, home }).status, 0)
  const allow = join(cwd, ".onehook-noslop", "allow")
  writeFileSync(allow, "docs/style-guide.md\n")
  const again = run(["install", "--project", "--agent", "cursor"], { cwd, home })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(allow, "utf8"), "docs/style-guide.md\n")
  assert.ok(!existsSync(join(home, ".onehook-noslop")))
})

test("a bad config stops the install before any file is written", () => {
  const home = mkdtempSync(join(tmpdir(), "noslop-home-"))
  mkdirSync(join(home, ".claude"))
  mkdirSync(join(home, ".codex"))
  writeFileSync(join(home, ".codex", "hooks.json"), "{ not json")
  const r = run(["install"], { cwd: home, home })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Cannot parse/)
  assert.ok(!existsSync(join(home, ".claude", "settings.json")))
  assert.equal(readFileSync(join(home, ".codex", "hooks.json"), "utf8"), "{ not json")
})

test("unknown agent is rejected", () => {
  const home = mkdtempSync(join(tmpdir(), "noslop-home-"))
  const r = run(["install", "--agent", "vim"], { cwd: home, home })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Unknown agent: vim/)
})
