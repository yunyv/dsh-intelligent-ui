/**
 * Artifact source normalization. The frame supplies the document skeleton,
 * theme, and Content-Security-Policy, so a model that writes a complete HTML
 * document still lands correctly: the skeleton tags are unwrapped (order
 * preserved, nothing dropped) and any CSP the model tried to declare is removed
 * so it cannot weaken the frame's own policy.
 * @module dsh-artifacts-live/normalize
 */

/** Skeleton tags whose open/close forms are unwrapped, keeping their content. */
const SKELETON = /<\/?(?:!doctype\b[^>]*|html\b[^>]*|head\b[^>]*|body\b[^>]*)\/?>/gi

/** A model-declared Content-Security-Policy meta, in either attribute order. */
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi

/** Whether the source declared a document skeleton of its own. */
export function declaresSkeleton(source: string): boolean {
	return /<!doctype\s+html|<html\b|<body\b|<head\b/iu.test(source)
}

/**
 * Reduce a source to frame-embeddable content.
 * @param source - fragment or complete document.
 * @returns markup safe to embed in the frame's `<body>`.
 */
export function normalizeArtifactSource(source: string): string {
	return source.replace(CSP_META, '').replace(SKELETON, '').trim()
}

/**
 * The size the frame actually carries, measured after normalization so the cap
 * reflects what the browser must parse.
 * @param source - raw model source.
 * @returns UTF-8 byte length of the normalized source.
 */
export function normalizedBytes(source: string): number {
	return new TextEncoder().encode(normalizeArtifactSource(source)).length
}
