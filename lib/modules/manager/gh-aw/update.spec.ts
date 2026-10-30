import { codeBlock } from 'common-tags';
import type { Upgrade } from '../types.ts';
import { updateDependency } from './index.ts';
import type { GhAwManagerData } from './types.ts';

const fileContent = `${codeBlock`
  {
    "entries": {
      "actions/checkout@v7.0.1": {
        "repo": "actions/checkout",
        "version": "v7.0.1",
        "sha": "3d3c42e5aac5ba805825da76410c181273ba90b1",
        "inputs": {
          "ref": {
            "description": "The branch, tag or SHA to checkout."
          }
        },
        "action_description": "Checkout a Git repository"
      },
      "actions/github-script@v9.0.0": {
        "repo": "actions/github-script",
        "version": "v9.0.0",
        "sha": "3a2844b7e9c422d3c10d287c895573f7108da1b3"
      }
    },
    "containers": {}
  }
`}\n`;

const checkoutUpgrade: Upgrade<GhAwManagerData> = {
  depName: 'actions/checkout',
  currentValue: 'v7.0.1',
  currentDigest: '3d3c42e5aac5ba805825da76410c181273ba90b1',
  newValue: 'v7.1.0',
  newDigest: '1111111111111111111111111111111111111111',
  managerData: {
    kind: 'action',
    key: 'actions/checkout@v7.0.1',
    repo: 'actions/checkout',
  },
};

describe('modules/manager/gh-aw/update', () => {
  describe('updateDependency()', () => {
    it('re-keys and re-pins the entry as gh-aw writes it, dropping the old commit metadata', () => {
      const res = updateDependency({
        fileContent,
        packageFile: '.github/aw/actions-lock.json',
        upgrade: checkoutUpgrade,
      });

      expect(res).toBe(
        `${codeBlock`
          {
            "entries": {
              "actions/checkout@v7.1.0": {
                "repo": "actions/checkout",
                "version": "v7.1.0",
                "sha": "1111111111111111111111111111111111111111"
              },
              "actions/github-script@v9.0.0": {
                "repo": "actions/github-script",
                "version": "v9.0.0",
                "sha": "3a2844b7e9c422d3c10d287c895573f7108da1b3"
              }
            }
          }
        `}\n`,
      );
    });

    it('keeps the commit metadata for a version-only change on the same commit', () => {
      const res = updateDependency({
        fileContent,
        packageFile: '.github/aw/actions-lock.json',
        upgrade: {
          ...checkoutUpgrade,
          newDigest: '3d3c42e5aac5ba805825da76410c181273ba90b1',
        },
      });

      expect(JSON.parse(res!).entries['actions/checkout@v7.1.0']).toEqual({
        repo: 'actions/checkout',
        version: 'v7.1.0',
        sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
        inputs: {
          ref: { description: 'The branch, tag or SHA to checkout.' },
        },
        action_description: 'Checkout a Git repository',
      });
    });

    it('re-pins a digest-only update under the same key, sorted by key', () => {
      const res = updateDependency({
        fileContent,
        packageFile: '.github/aw/actions-lock.json',
        upgrade: {
          depName: 'actions/github-script',
          currentValue: 'v9.0.0',
          newDigest: '2222222222222222222222222222222222222222',
          managerData: {
            kind: 'action',
            key: 'actions/github-script@v9.0.0',
            repo: 'actions/github-script',
          },
        },
      });

      const { entries } = JSON.parse(res!);
      expect(Object.keys(entries)).toEqual([
        'actions/checkout@v7.0.1',
        'actions/github-script@v9.0.0',
      ]);
      expect(entries['actions/github-script@v9.0.0'].sha).toBe(
        '2222222222222222222222222222222222222222',
      );
    });

    it('returns the content unchanged when an existing branch already carries the update', () => {
      const updated = updateDependency({
        fileContent,
        packageFile: '.github/aw/actions-lock.json',
        upgrade: checkoutUpgrade,
      })!;

      expect(
        updateDependency({
          fileContent: updated,
          packageFile: '.github/aw/actions-lock.json',
          upgrade: checkoutUpgrade,
        }),
      ).toBe(updated);
    });

    it('moves a replaced action to its new repository, keeping its path', () => {
      const res = updateDependency({
        fileContent: JSON.stringify({
          entries: {
            'old/cache/restore@v1': {
              repo: 'old/cache/restore',
              version: 'v1',
              sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
            },
          },
        }),
        packageFile: '.github/aw/actions-lock.json',
        upgrade: {
          depName: 'old/cache',
          newName: 'new/cache',
          currentValue: 'v1',
          newValue: 'v2',
          newDigest: '1111111111111111111111111111111111111111',
          managerData: {
            kind: 'action',
            key: 'old/cache/restore@v1',
            repo: 'old/cache/restore',
          },
        },
      });

      expect(JSON.parse(res!).entries).toEqual({
        'new/cache/restore@v2': {
          repo: 'new/cache/restore',
          version: 'v2',
          sha: '1111111111111111111111111111111111111111',
        },
      });
    });

    describe('containers', () => {
      const oldDigest =
        'sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f';
      const newDigest =
        'sha256:3333333333333333333333333333333333333333333333333333333333333333';
      const containerContent = JSON.stringify({
        entries: {},
        containers: {
          'node:24': {
            image: 'node:24',
            digest: oldDigest,
            pinned_image: `node:24@${oldDigest}`,
          },
          'ghcr.io/example/untagged': {
            image: 'ghcr.io/example/untagged',
            digest: oldDigest,
            pinned_image: `ghcr.io/example/untagged@${oldDigest}`,
          },
        },
      });

      it('re-keys and re-pins a tag update', () => {
        const res = updateDependency({
          fileContent: containerContent,
          packageFile: '.github/aw/actions-lock.json',
          upgrade: {
            depName: 'node',
            currentValue: '24',
            newValue: '26',
            currentDigest: oldDigest,
            newDigest,
            managerData: { kind: 'container', key: 'node:24', image: 'node' },
          },
        });

        expect(JSON.parse(res!).containers).toEqual({
          'ghcr.io/example/untagged': {
            image: 'ghcr.io/example/untagged',
            digest: oldDigest,
            pinned_image: `ghcr.io/example/untagged@${oldDigest}`,
          },
          'node:26': {
            image: 'node:26',
            digest: newDigest,
            pinned_image: `node:26@${newDigest}`,
          },
        });
      });

      it('moves a replaced image to its new name', () => {
        const res = updateDependency({
          fileContent: containerContent,
          packageFile: '.github/aw/actions-lock.json',
          upgrade: {
            depName: 'node',
            newName: 'ghcr.io/example/node',
            currentValue: '24',
            newValue: '24',
            newDigest,
            managerData: { kind: 'container', key: 'node:24', image: 'node' },
          },
        });

        expect(JSON.parse(res!).containers['ghcr.io/example/node:24']).toEqual({
          image: 'ghcr.io/example/node:24',
          digest: newDigest,
          pinned_image: `ghcr.io/example/node:24@${newDigest}`,
        });
      });

      it('re-pins an untagged image', () => {
        const res = updateDependency({
          fileContent: containerContent,
          packageFile: '.github/aw/actions-lock.json',
          upgrade: {
            depName: 'ghcr.io/example/untagged',
            currentDigest: oldDigest,
            newDigest,
            managerData: {
              kind: 'container',
              key: 'ghcr.io/example/untagged',
              image: 'ghcr.io/example/untagged',
            },
          },
        });

        expect(JSON.parse(res!).containers['ghcr.io/example/untagged']).toEqual(
          {
            image: 'ghcr.io/example/untagged',
            digest: newDigest,
            pinned_image: `ghcr.io/example/untagged@${newDigest}`,
          },
        );
      });

      it('returns the content unchanged when the image is already updated', () => {
        const upgrade: Upgrade<GhAwManagerData> = {
          depName: 'node',
          currentValue: '24',
          newValue: '26',
          newDigest,
          managerData: { kind: 'container', key: 'node:24', image: 'node' },
        };
        const updated = updateDependency({
          fileContent: containerContent,
          packageFile: '.github/aw/actions-lock.json',
          upgrade,
        })!;

        expect(
          updateDependency({
            fileContent: updated,
            packageFile: '.github/aw/actions-lock.json',
            upgrade,
          }),
        ).toBe(updated);
      });

      it('returns null without a containers section', () => {
        expect(
          updateDependency({
            fileContent: '{"entries":{}}',
            packageFile: '.github/aw/actions-lock.json',
            upgrade: {
              depName: 'node',
              newDigest,
              managerData: { kind: 'container', key: 'node:24', image: 'node' },
            },
          }),
        ).toBeNull();
      });
    });

    it.each`
      reason                  | content                                          | upgrade
      ${'no entry key'}       | ${fileContent}                                   | ${{ ...checkoutUpgrade, managerData: undefined }}
      ${'invalid JSON'}       | ${'not json'}                                    | ${checkoutUpgrade}
      ${'no entries'}         | ${'{}'}                                          | ${checkoutUpgrade}
      ${'a missing entry'}    | ${fileContent}                                   | ${{ ...checkoutUpgrade, managerData: { kind: 'action', key: 'actions/missing@v1', repo: 'actions/missing' } }}
      ${'no new digest'}      | ${fileContent}                                   | ${{ ...checkoutUpgrade, newDigest: undefined }}
      ${'a non-object entry'} | ${'{"entries":{"actions/checkout@v7.0.1":"x"}}'} | ${checkoutUpgrade}
    `(
      'returns null for $reason',
      ({
        content,
        upgrade,
      }: {
        content: string;
        upgrade: Upgrade<GhAwManagerData>;
      }) => {
        expect(
          updateDependency({
            fileContent: content,
            packageFile: '.github/aw/actions-lock.json',
            upgrade,
          }),
        ).toBeNull();
      },
    );
  });

  describe('workflow sources', () => {
    const packageFile = '.github/workflows/triage.md';
    const oldSha = '08c6903cd8c0fde910a37f88322edcfb5dd907a8';
    const newSha = '1af3b93b6815bc44a9784bd300feb67ff0d1eeb3';
    const source = codeBlock`
      ---
      steps:
        - uses: 'actions/checkout@${oldSha}' # v5.0.0 pinned for safety
      ---
    `;
    const sourceUpgrade: Upgrade<GhAwManagerData> = {
      depName: 'actions/checkout',
      currentValue: 'v5.0.0',
      currentDigest: oldSha,
      newValue: 'v6.0.0',
      newDigest: newSha,
      managerData: { kind: 'source', repo: 'actions/checkout' },
    };

    it('re-pins the `uses:` and moves the version in its comment', () => {
      expect(
        updateDependency({
          fileContent: source,
          packageFile,
          upgrade: sourceUpgrade,
        }),
      ).toBe(codeBlock`
        ---
        steps:
          - uses: 'actions/checkout@${newSha}' # v6.0.0 pinned for safety
        ---
      `);
    });

    it('keeps the comment of a digest-only update', () => {
      expect(
        updateDependency({
          fileContent: source,
          packageFile,
          upgrade: {
            ...sourceUpgrade,
            currentValue: undefined,
            newValue: undefined,
          },
        }),
      ).toBe(source.replace(oldSha, newSha));
    });

    it('returns the content unchanged when an existing branch already carries the update', () => {
      const updated = source
        .replace(oldSha, newSha)
        .replace('v5.0.0', 'v6.0.0');

      expect(
        updateDependency({
          fileContent: updated,
          packageFile,
          upgrade: sourceUpgrade,
        }),
      ).toBe(updated);
    });

    it('returns null when the reference is gone', () => {
      expect(
        updateDependency({
          fileContent: '---\n---\n',
          packageFile,
          upgrade: sourceUpgrade,
        }),
      ).toBeNull();
    });
  });
});
