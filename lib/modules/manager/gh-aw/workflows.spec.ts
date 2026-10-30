import { codeBlock } from 'common-tags';
import type { Upgrade } from '../types.ts';
import type { GhAwManagerData } from './types.ts';
import { updateWorkflowSource } from './workflows.ts';

const oldSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const newSha = '1111111111111111111111111111111111111111';
const oldDigest = `sha256:${'2'.repeat(64)}`;
const newDigest = `sha256:${'3'.repeat(64)}`;

const checkout: Upgrade<GhAwManagerData> = {
  currentValue: 'v7',
  currentDigest: oldSha,
  newValue: 'v8',
  newDigest: newSha,
  managerData: {
    kind: 'action',
    key: 'actions/checkout@v7',
    repo: 'actions/checkout',
  },
};

const node: Upgrade<GhAwManagerData> = {
  currentValue: '24',
  newValue: '26',
  currentDigest: oldDigest,
  newDigest,
  managerData: { kind: 'container', key: 'node:24', image: 'node' },
};

describe('modules/manager/gh-aw/workflows', () => {
  describe('updateWorkflowSource()', () => {
    it('rewrites tag and commit references to the updated action', () => {
      const content = codeBlock`
        ---
        steps:
          - uses: actions/checkout@v7
          - uses: actions/checkout@${oldSha} # v7
          - uses: actions/checkout@${oldSha}
          - uses: actions/checkout@v6
          - uses: actions/checkout-other@v7
          - uses: actions/checkout@${'f'.repeat(40)} # v6
        ---
        Run \`uses: actions/checkout@v7\` in the body as well.
      `;

      expect(updateWorkflowSource(content, [checkout])).toBe(codeBlock`
        ---
        steps:
          - uses: actions/checkout@v8
          - uses: actions/checkout@${newSha} # v8
          - uses: actions/checkout@${newSha} # v8
          - uses: actions/checkout@v6
          - uses: actions/checkout-other@v7
          - uses: actions/checkout@${'f'.repeat(40)} # v6
        ---
        Run \`uses: actions/checkout@v7\` in the body as well.
      `);
    });

    it('rewrites quoted references and keeps the rest of the comment', () => {
      const content = codeBlock`
        steps:
          - uses: "actions/checkout@v7"
          - uses: 'actions/checkout@${oldSha}' # v7 pinned for X
          - uses: actions/checkout@v7 # keep this comment
          - uses: https://github.example.com/actions/checkout@v7
          - uses: ./actions/checkout
      `;

      expect(updateWorkflowSource(content, [checkout])).toBe(codeBlock`
        steps:
          - uses: "actions/checkout@v8"
          - uses: 'actions/checkout@${newSha}' # v8 pinned for X
          - uses: actions/checkout@v8 # keep this comment
          - uses: https://github.example.com/actions/checkout@v7
          - uses: ./actions/checkout
      `);
    });

    it('matches an action in a subdirectory by its full path', () => {
      const restore: Upgrade<GhAwManagerData> = {
        ...checkout,
        managerData: {
          kind: 'action',
          key: 'actions/cache/restore@v7',
          repo: 'actions/cache/restore',
        },
      };
      const content = codeBlock`
        - uses: actions/cache/restore@v7
        - uses: actions/cache@v7
      `;

      expect(
        updateWorkflowSource(`  ${content.replaceAll('\n', '\n  ')}`, [
          restore,
        ]),
      ).toBe(`  - uses: actions/cache/restore@v8\n  - uses: actions/cache@v7`);
    });

    it('adds a version comment to a commit without one', () => {
      const update: Upgrade<GhAwManagerData> = {
        ...checkout,
        currentValue: undefined,
      };

      expect(
        updateWorkflowSource(`  - uses: actions/checkout@${oldSha}`, [update]),
      ).toBe(`  - uses: actions/checkout@${newSha} # v8`);
    });

    it('moves replaced references to the new action and image', () => {
      const content = codeBlock`
        ---
        container: node:24
        steps:
          - uses: actions/checkout@v7
        ---
      `;

      expect(
        updateWorkflowSource(content, [
          { ...checkout, depName: 'actions/checkout', newName: 'new/checkout' },
          { ...node, newName: 'ghcr.io/example/node' },
        ]),
      ).toBe(codeBlock`
        ---
        container: ghcr.io/example/node:26
        steps:
          - uses: new/checkout@v8
        ---
      `);
    });

    it('keeps a tag reference for a digest-only update', () => {
      const content = 'steps:\n  - uses: actions/checkout@v7\n';

      expect(
        updateWorkflowSource(content, [{ ...checkout, newValue: undefined }]),
      ).toBe(content);
    });

    it('rewrites image references only in the frontmatter', () => {
      const content = codeBlock`
        ---
        container: node:24
        node:24
        services:
          db: "node:24@${oldDigest}"
          other: [node:24, mynode:24, node:240]
        ---
        container: node:24
      `;

      expect(updateWorkflowSource(content, [node])).toBe(codeBlock`
        ---
        container: node:26
        node:26
        services:
          db: "node:26@${newDigest}"
          other: [node:26, mynode:24, node:240]
        ---
        container: node:24
      `);
    });

    it('rewrites an untagged image reference', () => {
      const untagged: Upgrade<GhAwManagerData> = {
        newDigest,
        managerData: {
          kind: 'container',
          key: 'ghcr.io/example/img',
          image: 'ghcr.io/example/img',
        },
      };
      const content = `---\nimage: ghcr.io/example/img@${oldDigest}\nother: ghcr.io/example/img:1\n---\n`;

      expect(updateWorkflowSource(content, [untagged])).toBe(
        `---\nimage: ghcr.io/example/img@${newDigest}\nother: ghcr.io/example/img:1\n---\n`,
      );
    });

    it('ignores images without frontmatter, and keeps CRLF line endings', () => {
      const content = 'container: node:24\r\n  - uses: actions/checkout@v7\r\n';

      expect(updateWorkflowSource(content, [checkout, node])).toBe(
        'container: node:24\r\n  - uses: actions/checkout@v8\r\n',
      );
    });

    it('returns the content unchanged without pinned updates', () => {
      const content = '- uses: actions/checkout@v7\n';

      expect(
        updateWorkflowSource(content, [
          { ...checkout, newDigest: undefined },
          { newDigest },
        ]),
      ).toBe(content);
    });
  });
});
