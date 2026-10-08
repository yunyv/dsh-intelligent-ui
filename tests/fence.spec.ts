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
import { compileDil } from '../src/dil/index.ts'
import { act } from 'react'
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

// React only flushes synchronously inside act() when the environment says so.
// Without this it falls back to a warning and a timer, which makes the engine
// dispatch assertions below order-dependent.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

/**
 * Which view a marker decides to mount.
 *
 * `fence.spec.ts` above drives the claiming rules with an injected mount, so it
 * never reaches React. These use the real mount: the point is the dispatch — a
 * revision that carries a compiled program must not be framed as HTML, and vice
 * versa — because getting that wrong is a card that renders the wrong thing or
 * nothing at all.
 */
describe('engine dispatch', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	const SOURCE = `给团队算一笔账。

{@body const [seats,setSeats] = DIL.useState(5)}
{@body const total = 20 * 12 * seats}
<box gap={4}>
  <title size="lg">订阅成本</title>
  <slider label="席位" value={seats} onChange={setSeats} min={1} max={50}/>
  <title size="xl" tabularNums>{total.toLocaleString()}</title>
</box>`

	/** A revision carrying a real compiled program. */
	function compiled(id: string) {
		return {
			kind: 'artifact' as const,
			engine: 'dil' as const,
			action: 'create' as const,
			id,
			title: '订阅成本',
			version: 1,
			mode: 'inline' as const,
			sizeBytes: SOURCE.length,
			session: 'session-1',
			dil: compileDil(SOURCE)
		}
	}

	/** The host element the channel inserted, or null. */
	function hostFor(id: string): HTMLElement | null {
		return document.querySelector(`[data-dsh-artifact="${id}"]`)
	}

	/** The element inside the card that carries the interface's shadow root. */
	function shadowHostOf(host: HTMLElement): HTMLElement | undefined {
		return [...host.querySelectorAll('*')].find(node => (node as HTMLElement).shadowRoot !== null) as HTMLElement | undefined
	}

	it('mounts the compiled interface at its marker instead of a frame', async () => {
		artifactStore.publish(compiled('art-dil00001'))
		const block = markerBlock('dsh-artifact', 'art-dil00001')
		const channel = new FenceChannel(reactFenceMount)
		await act(async () => { channel.start() })

		expect(block.style.display).toBe('none')
		const host = hostFor('art-dil00001')
		expect(host).not.toBeNull()
		expect(host?.textContent).toContain('订阅成本')
		// The controls this path offers are its own; the HTML path's preview toggle
		// must not appear, or the reader is being offered a frame that is not there.
		expect(host?.textContent).toContain('把当前设置交回对话')
		expect(host?.textContent).not.toContain('在此预览')
		expect(host?.querySelector('iframe')).toBeNull()

		// The interface itself is drawn by the DIL renderer inside a shadow root, so
		// host styles cannot reach it and the theme tokens still cross.
		const shadowHost = host === null ? undefined : shadowHostOf(host)
		expect(shadowHost).toBeDefined()
		expect(shadowHost?.shadowRoot).not.toBeNull()
		expect(shadowHost?.shadowRoot?.querySelector('style')).not.toBeNull()

		await act(async () => { channel.stop() })
	})

	it('keeps the raw document on a frame', async () => {
		artifactStore.publish(artifact('art-html0001'))
		const block = markerBlock('dsh-artifact', 'art-html0001')
		const channel = new FenceChannel(reactFenceMount)
		await act(async () => { channel.start() })

		expect(block.style.display).toBe('none')
		const host = hostFor('art-html0001')
		// A framed document offers the frame’s own chrome: hand the collected
		// interaction back, copy the source, export it. The compiled path’s control
		// must not appear here either.
		expect(host?.textContent).toContain('提交交互数据')
		expect(host?.textContent).toContain('导出 HTML')
		expect(host?.textContent).not.toContain('把当前设置交回对话')

		await act(async () => { channel.stop() })
	})
})
