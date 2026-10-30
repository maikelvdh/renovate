import type { DepTypeMetadata } from '../types.ts';

export const knownDepTypes = [
  {
    depType: 'action',
    description:
      'An action pinned in the `entries` of `.github/aw/actions-lock.json` (e.g. `actions/checkout@v7.0.1`), or pinned to a commit in the frontmatter of a workflow source',
  },
  {
    depType: 'container',
    description:
      'A container image pinned in the `containers` of `.github/aw/actions-lock.json` (e.g. `node:24`)',
  },
  {
    depType: 'gh-aw',
    description:
      'The `gh aw` CLI, as recorded by the version of its `setup` action (e.g. `github/gh-aw-actions/setup@v1.0.1`)',
  },
] as const satisfies readonly DepTypeMetadata[];
