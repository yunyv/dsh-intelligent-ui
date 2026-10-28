/** NewCM 4.1.3 SVG data: every optional shard is included in the offline Worker. */
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/js/svg.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js'
import '@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js'

/**
 * Static imports register callbacks on the class, but do not apply them to an
 * instance. Do that explicitly: loadDynamicFiles[Sync]() would call asyncLoad,
 * and touching a not-yet-expanded character can otherwise request a shard.
 */
class OfflineNewcmFont extends MathJaxNewcmFont {
	constructor() {
		super()
		const files = Object.values(OfflineNewcmFont.dynamicFiles)
		if (files.length !== 40) throw new Error('Unexpected NewCM 4.1.3 SVG shard manifest')
		for (const file of files) {
			if (typeof file.setup !== 'function') throw new Error(`Missing offline NewCM shard: ${file.file}`)
			file.setup(this)
		}
	}
}

export function createNewcmFont(): MathJaxNewcmFont {
	return new OfflineNewcmFont()
}
