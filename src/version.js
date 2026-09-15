import packageMetadata from "../package.json" with { type: "json" }

// Keep one package version in every envelope
export const VERSION = packageMetadata.version
