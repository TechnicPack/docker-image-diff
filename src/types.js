/**
 * @typedef {{key: string, image: string}} ImageReference
 * @typedef {{references: ImageReference[], warnings: string[], incomplete?: boolean, skippedKeys?: string[]}} Discovery
 * @typedef {{registry: string, repository: string, tag?: string, digest?: string, canonical: string}} Image
 * @typedef {{platform: string, digest: string, version?: string, baseName?: string, baseDigest?: string, revision?: string, source?: string}} Platform
 * @typedef {{image: string, platforms: Platform[], warnings: string[]}} Inspection
 * @typedef {{file: string, location: string, before?: string, after?: string}} ImageChange
 * @typedef {{change: ImageChange, before?: Inspection, after?: Inspection, warnings: string[]}} Comparison
 */
export {};
