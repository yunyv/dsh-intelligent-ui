/**
 * Where the skill's files live, free of harness imports.
 *
 * The tool's description names the skill body so an agent without a skill tool
 * can still read the contract, which means the paths have to be reachable
 * without importing the skill registry. `src/skill.ts` and `src/tool.ts` both
 * read them from here.
 *
 * @module dsh-genui/paths
 */

import { fileURLToPath } from 'node:url'

/** Location of the skill body, as the skill provider's locator. */
export const SKILL_BODY_URL = new URL('../assets/genui-skill.md', import.meta.url)

/** Absolute path of the skill body, for agents that cannot load skills. */
export const SKILL_BODY_PATH = fileURLToPath(SKILL_BODY_URL)

/** Absolute directory the skill body's relative references resolve against. */
export const SKILL_RESOURCE_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
