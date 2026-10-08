// @vitest-environment jsdom
/**
 * The fence channel: how an artifact takes its position inside the answer.
 *
 * These drive the real DOM surface the platform renders — `div.md-code-block`
 * with the fence language in its banner — so a change in either the marker rules
 * or the mounted result fails here rather than in the GUI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FenceChannel, markerIdOf, markedId, reactFenceMount, readFence } from '../src/client/fence.tsx'
import { artifactStore } from '../src/client/store.ts'
import type { ArtifactMeta } from '../src/meta.ts'

/** One revision as the tool result would carry it. */
function artifact(id: string, version = 1): ArtifactMeta {
	return {
		kind: 'artifact',
		engine: 'html',
		action: version === 1 ? 'create' : 'patch',
		id,
		title: '演示',
		html: '<b>demo</b>',
		version,
		mode: 'inline',
		render: version === 1 ? 'reload' : 'reconcile',
		sizeBytes: 12,
		session: 'session-1'
	}
}

/** One rendered marker block, shaped like the platform's code block. */
function markerBlock(lang: string, body: string): HTMLElement {
	const block = document.createElement('div')
	block.className = 'md-code-block'
	const banner = document.createElement('div')
	banner.setAttribute('data-code-block-banner', '')
	banner.textContent = lang
	const pre = document.createElement('pre')
	pre.textContent = body
	block.append(banner, pre)
	document.body.append(block)
	return block
}

describe('marker grammar', () => {
	it('takes the id from a block whose fence language is the artifact fence', () => {
		expect(markerIdOf('dsh-artifact', 'art-at8dcaa7')).toBe('art-at8dcaa7')
		expect(markerIdOf('DSH-Artifact', '  art-at8dcaa7  \nignored')).toBe('art-at8dcaa7')
	})

	it('leaves a block that names the fence without an id alone', () => {
		expect(markerIdOf('dsh-artifact', '')).toBeUndefined()
		expect(markerIdOf('dsh-artifact', 'not-an-id')).toBeUndefined()
	})

	it('accepts a self-describing marker when the host drops the info string', () => {
		expect(markerIdOf('', 'dsh-artifact art-at8dcaa7')).toBe('art-at8dcaa7')
		expect(markerIdOf('', 'dsh-artifact')).toBeUndefined()
	})

	it('accepts a bare id, which is all this host leaves in the DOM', () => {
		// The shipped renderer maps an unknown fence language to a localized label,
		// so the block reads as "code block" and only its body identifies it.
		expect(markerIdOf('代码块', 'art-at8dcaa7')).toBe('art-at8dcaa7')
		expect(markerIdOf('代码块', 'art-at8dcaa7\n')).toBe('art-at8dcaa7')
	})

	it('ignores every other code block', () => {
		expect(markerIdOf('js', 'const x = 1')).toBeUndefined()
		expect(markerIdOf('html', '<div>art-at8dcaa7</div>')).toBeUndefined()
	})

	it('reads the surface the platform actually renders', () => {
		const block = markerBlock('dsh-artifact', 'art-at8dcaa7')
		expect(readFence(block)).toEqual({ lang: 'dsh-artifact', body: 'art-at8dcaa7' })
		expect(markedId(block)).toBe('art-at8dcaa7')
	})
})

describe('fence channel', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('mounts one frame in place of the marker and hides the block', () => {
		artifactStore.publish(artifact('art-aaaaaaaa'))
		const block = markerBlock('dsh-artifact', 'art-aaaaaaaa')
		const mounts: string[] = []
		const channel = new FenceChannel((host, id) => {
			mounts.push(id)
			host.textContent = `mounted:${id}`
			return () => { mounts.push(`dispose:${id}`) }
		})
		channel.start()

		expect(mounts).toEqual(['art-aaaaaaaa'])
		expect(block.style.display).toBe('none')
		const host = document.querySelector('[data-dsh-artifact="art-aaaaaaaa"]')
		expect(host?.textContent).toBe('mounted:art-aaaaaaaa')
		expect(host?.previousElementSibling).toBeNull()

		channel.stop()
		expect(mounts).toEqual(['art-aaaaaaaa', 'dispose:art-aaaaaaaa'])
	})

	it('leaves a marker for an artifact this page has never seen as code', () => {
		const block = markerBlock('dsh-artifact', 'art-bbbbbbbb')
		const channel = new FenceChannel(() => () => undefined)
		channel.start()

		expect(channel.claimed).toBe(0)
		expect(block.style.display).toBe('')
	})

	it('claims a marker that arrives after the artifact is known', () => {
		const block = markerBlock('dsh-artifact', 'art-cccccccc')
		const mounts: string[] = []
		const channel = new FenceChannel((_host, id) => {
			mounts.push(id)
			return () => undefined
		})
		channel.start()
		expect(mounts).toEqual([])

		artifactStore.publish(artifact('art-cccccccc'))
		channel.scan()
		expect(mounts).toEqual(['art-cccccccc'])
		expect(block.style.display).toBe('none')
	})

	it('releases a claim when the transcript drops the block', () => {
		artifactStore.publish(artifact('art-dddddddd'))
		const block = markerBlock('dsh-artifact', 'art-dddddddd')
		const disposed: string[] = []
		const channel = new FenceChannel((_host, id) => () => { disposed.push(id) })
		channel.start()
		expect(channel.claimed).toBe(1)

		block.remove()
		channel.scan()
		expect(channel.claimed).toBe(0)
		expect(disposed).toEqual(['art-dddddddd'])
	})
})

describe('fence mount', () => {
	it('mounts the artifact\'s real frame where the marker was', async () => {
		artifactStore.publish(artifact('art-eeeeeeee'))
		const block = markerBlock('dsh-artifact', 'art-eeeeeeee')
		const channel = new FenceChannel(reactFenceMount)
		channel.start()
		// React 18 flushes a root render on a scheduler tick.
		await new Promise(resolve => setTimeout(resolve, 0))

		const frame = document.querySelector('[data-dsh-artifact="art-eeeeeeee"] iframe')
		expect(frame, 'the marker must render the artifact frame').not.toBeNull()
		expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-modals')
		expect(frame?.getAttribute('srcdoc')).toContain('dsh-artifact-root')
		expect(block.style.display).toBe('none')

		channel.stop()
		expect(document.querySelector('[data-dsh-artifact="art-eeeeeeee"] iframe')).toBeNull()
	})
})

describe('fence poll', () => {
	it('keeps a one-second poll, so a missed mutation cannot lose a marker', () => {
		const setSpy = vi.spyOn(globalThis, 'setInterval')
		const clearSpy = vi.spyOn(globalThis, 'clearInterval')
		const channel = new FenceChannel(() => () => undefined)
		channel.start()
		expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 1000)
		channel.stop()
		expect(clearSpy).toHaveBeenCalled()
		setSpy.mockRestore()
		clearSpy.mockRestore()
	})
})
