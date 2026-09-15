import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  SKILL_FILES,
  SkillInstallationError,
  bundledSkillRoot,
  installBundledSkill,
  resolveSkillInstallTarget,
  validateBundledSkill,
} from "../src/index.js"

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-thread-test-"))
}

function cleanup(...directories) {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
}

test("installs the exact bundled skill into an isolated CODEX_HOME", () => {
  const home = temporaryDirectory()
  const codexHome = path.join(home, "codex-home")
  try {
    assert.equal(validateBundledSkill(bundledSkillRoot()), bundledSkillRoot())
    const result = installBundledSkill("codex", {
      homeDirectory: home,
      env: { CODEX_HOME: codexHome },
    })
    assert.equal(result.destination, path.join(codexHome, "skills", "codex-thread"))
    assert.equal(result.replaced, false)
    for (const relativePath of SKILL_FILES) {
      assert.equal(
        fs.readFileSync(path.join(result.destination, relativePath), "utf8"),
        fs.readFileSync(path.join(bundledSkillRoot(), relativePath), "utf8"),
      )
    }
  } finally {
    cleanup(home)
  }
})

test("refuses to replace user files without an explicit policy", () => {
  const home = temporaryDirectory()
  const destination = resolveSkillInstallTarget("codex", {
    homeDirectory: home,
    env: {},
  }).destination
  fs.mkdirSync(destination, { recursive: true })
  const editedFile = path.join(destination, "user-edited.md")
  fs.writeFileSync(editedFile, "keep this file\n")
  try {
    assert.throws(
      () => installBundledSkill("codex", { homeDirectory: home, env: {} }),
      (error) => error instanceof SkillInstallationError
        && error.details.overwriteRequired === true,
    )
    assert.equal(fs.readFileSync(editedFile, "utf8"), "keep this file\n")
  } finally {
    cleanup(home)
  }
})

test("backs up an existing skill before replacement", () => {
  const home = temporaryDirectory()
  const destination = resolveSkillInstallTarget("codex", {
    homeDirectory: home,
    env: {},
  }).destination
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, "custom.md"), "user content\n")
  try {
    const result = installBundledSkill("codex", {
      homeDirectory: home,
      env: {},
      backup: true,
      randomBytes: () => Buffer.from([1, 2, 3, 4]),
    })
    assert.equal(result.replaced, true)
    assert.ok(result.backupPath)
    assert.equal(
      fs.readFileSync(path.join(result.backupPath, "custom.md"), "utf8"),
      "user content\n",
    )
    assert.equal(fs.statSync(path.join(result.destination, "SKILL.md")).isFile(), true)
  } finally {
    cleanup(home)
  }
})

test("rejects symlinked installation paths without writing outside the target", () => {
  for (const kind of ["skills-root", "destination"]) {
    const home = temporaryDirectory()
    const outside = temporaryDirectory()
    const target = resolveSkillInstallTarget("codex", { homeDirectory: home, env: {} })
    fs.mkdirSync(path.dirname(target.skillsRoot), { recursive: true })
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside\n")
    if (kind === "skills-root") {
      fs.symlinkSync(outside, target.skillsRoot, "dir")
    } else {
      fs.mkdirSync(target.skillsRoot)
      fs.symlinkSync(outside, target.destination, "dir")
    }

    try {
      assert.throws(
        () => installBundledSkill("codex", {
          homeDirectory: home,
          env: {},
          overwrite: true,
        }),
        (error) => error instanceof SkillInstallationError
          && error.details.path === (kind === "skills-root"
            ? target.skillsRoot
            : target.destination),
      )
      assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside\n")
      assert.equal(fs.readdirSync(outside).length, 1)
    } finally {
      cleanup(home, outside)
    }
  }
})
