/**
 * Bundled `genui` skill provider: the DIL authoring contract the model loads
 * before its first DIL-mode `artifact` call.
 *
 * In the system this dialect was reverse-engineered from, the contract is
 * injected server-side on every request and never reaches the client. DSH has a
 * skill registry instead, so the same text ships here and is loaded on demand —
 * which also keeps ~4 KB of dialect rules out of every unrelated turn.
 *
 * @module dsh-genui/skill
 */

import { readFile } from 'node:fs/promises'
import {
	BUNDLED_SKILL_RANK,
	type SkillCandidate,
	type SkillDefinition,
	type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { SKILL_BODY_PATH, SKILL_BODY_URL, SKILL_RESOURCE_DIR } from './paths.ts'

const PROVIDER_NAME = 'dsh-genui'

const RESOURCE_BASE = {
	kind: 'directory',
	path: SKILL_RESOURCE_DIR,
} as const

const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const DESCRIPTION =
	'Authoring contract for the `artifact` tool in DIL mode: write a compiled, '
	+ 'interactive interface instead of prose. Covers when a surface earns its place, '
	+ 'the {@body}/DSL output format, the component and control inventory, the rules '
	+ 'that make a document run, and how to revise a surface in place. Load before the '
	+ 'first DIL-mode call in a session.'

const CANDIDATE: SkillCandidate = {
	name: 'genui',
	description: DESCRIPTION,
	invocation: INVOCATION,
	provider: PROVIDER_NAME,
	source: 'bundled',
	resourceBase: RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_URL,
}

/** The bundled provider registered on `ctx.skills`. */
export const genuiSkillProvider: SkillProvider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),
	async get(_candidate): Promise<SkillDefinition> {
		return {
			name: CANDIDATE.name,
			description: CANDIDATE.description,
			invocation: CANDIDATE.invocation,
			provider: CANDIDATE.provider,
			source: CANDIDATE.source,
			resourceBase: RESOURCE_BASE,
			content: await readFile(SKILL_BODY_URL, 'utf8'),
		}
	},
}
