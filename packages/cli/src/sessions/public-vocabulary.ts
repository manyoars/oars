// The public vocabulary (t755, recall spec Sections 2.1, 2.2, and 7): the one file that says which names may stand in a class P field of a
// captured step or frame. Anything else becomes `<literal>`, so a private script, host, package, or server name never reaches a pooled field.
//
// A simple list on purpose, and it fails closed: a missing public name costs a `<literal>`, while a wrongly listed one costs a leak. The D11 and
// D13 vocabulary spec owns the final list and wins on what may leave the machine. This repository is public, so nothing private is ever added here.

/** What every name outside this file becomes. */
export const LITERAL = '<literal>';

export const REPO_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type RepoSize = (typeof REPO_SIZES)[number];
