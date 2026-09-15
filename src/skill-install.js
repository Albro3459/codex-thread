import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { InvalidArgumentsError, SkillInstallationError } from "./errors.js"

export const SKILL_NAME = "codex-thread"
export const SKILL_FILES = Object.freeze([
  "SKILL.md",
  "agents/openai.yaml",
  "references/cli.md",
  "references/workflows.md",
])

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLED_SKILL_ROOT = path.join(PACKAGE_ROOT, "skills", SKILL_NAME)

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function exists(filePath) {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function assertRegularFile(filePath, details) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    throw new SkillInstallationError("A bundled skill file is missing or unreadable.", {
      ...details,
      path: filePath,
      reason: error?.code === "ENOENT" ? "missing" : "unreadable",
    }, error)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SkillInstallationError("A bundled skill entry must be a regular file.", {
      ...details,
      path: filePath,
    })
  }
}

export function validateBundledSkill(sourceRoot = BUNDLED_SKILL_ROOT) {
  const root = path.resolve(sourceRoot)
  let stat
  try {
    stat = fs.lstatSync(root)
  } catch (error) {
    throw new SkillInstallationError("The bundled skill was not found.", { sourceRoot: root }, error)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillInstallationError("The bundled skill source must be a regular directory.", {
      sourceRoot: root,
    })
  }
  for (const relativePath of SKILL_FILES) {
    assertRegularFile(path.join(root, relativePath), { sourceRoot: root, relativePath })
  }
  return root
}

export function resolveSkillInstallTarget(agent, {
  homeDirectory = os.homedir(),
  env = process.env,
} = {}) {
  if (agent !== "codex") {
    throw new InvalidArgumentsError("Skill target must be codex.", { field: "agent", value: agent })
  }
  if (typeof homeDirectory !== "string" || homeDirectory.trim() === "") {
    throw new InvalidArgumentsError("homeDirectory must be a non-empty path.", {
      field: "homeDirectory",
    })
  }

  const home = path.resolve(homeDirectory)
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(home, ".codex")
  const skillsRoot = path.join(codexHome, "skills")
  const destination = path.join(skillsRoot, SKILL_NAME)
  if (!pathIsInside(skillsRoot, destination) || path.basename(destination) !== SKILL_NAME) {
    throw new SkillInstallationError("The skill destination escaped the Codex skills directory.", {
      skillsRoot,
      destination,
    })
  }
  return Object.freeze({ agent, codexHome, skillsRoot, destination })
}

function assertDirectoryChain(directory) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let candidate = parsed.root

  for (const part of parts) {
    candidate = path.join(candidate, part)
    if (!exists(candidate)) continue
    const stat = fs.lstatSync(candidate)
    if (stat.isSymbolicLink()) {
      throw new SkillInstallationError("The skill destination path contains a symbolic link.", {
        path: candidate,
      })
    }
    if (!stat.isDirectory()) {
      throw new SkillInstallationError("A skill destination parent is not a directory.", {
        path: candidate,
      })
    }
  }
}

function assertSafeTarget(target) {
  assertDirectoryChain(target.skillsRoot)
  if (exists(target.destination)) {
    const stat = fs.lstatSync(target.destination)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SkillInstallationError("The existing skill destination must be a regular directory.", {
        path: target.destination,
      })
    }
  }
}

function uniqueSibling(destination, label, randomBytes = crypto.randomBytes) {
  return path.join(
    path.dirname(destination),
    `.${SKILL_NAME}.${label}-${process.pid}-${randomBytes(4).toString("hex")}`,
  )
}

function copySkill(source, destination) {
  for (const relativePath of SKILL_FILES) {
    const target = path.join(destination, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, relativePath), target, fs.constants.COPYFILE_EXCL)
  }
}

export function installBundledSkill(agent, {
  homeDirectory = os.homedir(),
  env = process.env,
  sourceRoot = BUNDLED_SKILL_ROOT,
  overwrite = false,
  backup = false,
  randomBytes = crypto.randomBytes,
} = {}) {
  const source = validateBundledSkill(sourceRoot)
  const target = resolveSkillInstallTarget(agent, { homeDirectory, env })
  assertSafeTarget(target)
  try {
    fs.mkdirSync(target.skillsRoot, { recursive: true })
  } catch (error) {
    throw new SkillInstallationError("Unable to create the Codex skills directory.", {
      skillsRoot: target.skillsRoot,
    }, error)
  }
  assertSafeTarget(target)

  const destinationExists = exists(target.destination)
  if (destinationExists && !overwrite && !backup) {
    throw new SkillInstallationError(
      "The skill already exists. Pass --overwrite or --backup to replace it.",
      { destination: target.destination, overwriteRequired: true },
    )
  }

  const temporary = uniqueSibling(target.destination, "install", randomBytes)
  const displaced = destinationExists
    ? uniqueSibling(target.destination, backup ? "backup" : "replace", randomBytes)
    : null
  let ownsTemporary = false
  let movedDestination = false
  let cleanupWarning = null

  try {
    if (exists(temporary) || (displaced && exists(displaced))) {
      throw new SkillInstallationError("Unable to create a unique installation path.", {
        temporary,
        displaced,
      })
    }
    fs.mkdirSync(temporary)
    ownsTemporary = true
    copySkill(source, temporary)
    if (displaced) {
      fs.renameSync(target.destination, displaced)
      movedDestination = true
    }
    fs.renameSync(temporary, target.destination)
    ownsTemporary = false
    if (displaced && !backup) {
      try {
        fs.rmSync(displaced, { recursive: true })
      } catch {
        cleanupWarning = {
          code: "OLD_SKILL_NOT_REMOVED",
          message: "The old skill was kept because cleanup failed.",
          details: { path: displaced },
        }
      }
    }
  } catch (error) {
    if (ownsTemporary && exists(temporary)) fs.rmSync(temporary, { recursive: true })
    if (movedDestination && !exists(target.destination) && exists(displaced)) {
      fs.renameSync(displaced, target.destination)
    }
    if (error instanceof SkillInstallationError) throw error
    throw new SkillInstallationError("Unable to install the bundled skill.", {
      source,
      destination: target.destination,
      backupPath: backup ? displaced : null,
    }, error)
  }

  return Object.freeze({
    schemaVersion: "codex-thread.skill-install.v1",
    skill: SKILL_NAME,
    destination: target.destination,
    backupPath: backup || cleanupWarning ? displaced : null,
    replaced: destinationExists,
    warnings: cleanupWarning ? [cleanupWarning] : [],
  })
}

export function bundledSkillRoot() {
  return BUNDLED_SKILL_ROOT
}
