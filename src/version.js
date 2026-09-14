import packageMetadata from "../package.json" with { type: "json" };

// Single source for the version stamped into every envelope, so a release bump cannot leave
// a stale default behind in a normalizer.
export const VERSION = packageMetadata.version;
