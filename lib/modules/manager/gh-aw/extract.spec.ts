import { codeBlock } from 'common-tags';
import { GlobalConfig } from '../../../config/global.ts';
import { getCompiledCliVersion } from './extract.ts';
import { extractPackageFile } from './index.ts';

const packageFile = '.github/aw/actions-lock.json';

describe('modules/manager/gh-aw/extract', () => {
  beforeEach(() => {
    GlobalConfig.reset();
  });

  describe('extractPackageFile()', () => {
    it('returns null for invalid JSON', () => {
      expect(extractPackageFile('not json', packageFile)).toBeNull();
    });

    it('returns null without entries', () => {
      expect(extractPackageFile('{"entries":{}}', packageFile)).toBeNull();
    });

    it('extracts the pinned actions', () => {
      const content = codeBlock`
        {
          "entries": {
            "actions/cache/restore@v6.1.0": {
              "repo": "actions/cache/restore",
              "version": "v6.1.0",
              "sha": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"
            },
            "actions/gh-drives-preview/checkout@main": {
              "repo": "actions/gh-drives-preview/checkout",
              "version": "main",
              "sha": "not-a-sha"
            },
            "invalid@v1": {
              "repo": "invalid"
            }
          }
        }
      `;

      expect(extractPackageFile(content, packageFile)).toEqual({
        deps: [
          {
            depName: 'actions/cache',
            commitMessageTopic: '{{{depName}}} action',
            depType: 'action',
            currentValue: 'v6.1.0',
            currentDigest: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
            datasource: 'github-tags',
            versioning: 'github-actions',
            managerData: {
              kind: 'action',
              key: 'actions/cache/restore@v6.1.0',
              repo: 'actions/cache/restore',
            },
          },
          {
            depName: 'actions/gh-drives-preview',
            commitMessageTopic: '{{{depName}}} action',
            depType: 'action',
            currentValue: 'main',
            skipReason: 'invalid-value',
            datasource: 'github-digest',
            versioning: 'exact',
            managerData: {
              kind: 'action',
              key: 'actions/gh-drives-preview/checkout@main',
              repo: 'actions/gh-drives-preview/checkout',
            },
          },
        ],
      });
    });

    it('extracts the pinned containers', () => {
      const content = JSON.stringify({
        entries: {},
        containers: {
          'node:24': {
            image: 'node:24',
            digest:
              'sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f',
            pinned_image:
              'node:24@sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f',
          },
          'ghcr.io/example/untagged': {
            image: 'ghcr.io/example/untagged',
            digest:
              'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          },
          'ghcr.io/github/gh-aw-firewall/agent:0.29.0': {
            image: 'ghcr.io/github/gh-aw-firewall/agent:0.29.0',
            digest:
              'sha256:b14bd399376180b5649a9324be3b50fbfc82bfe8f0c80045840416b5a4e65b96',
          },
          'ghcr.io/github/github-mcp-server:v2.0.3': {
            image: 'ghcr.io/github/github-mcp-server:v2.0.3',
            digest:
              'sha256:250bc6ce70788207608ef74cef4397230ff2e8481218da74d6093e4bd9101132',
          },
        },
      });

      expect(extractPackageFile(content, packageFile)?.deps).toMatchObject([
        {
          depName: 'node',
          depType: 'container',
          datasource: 'docker',
          currentValue: '24',
          currentDigest:
            'sha256:2c2ea524e648b91c8333ce246e3838fcf5b19ac70e45baac1a51b9207299749f',
          managerData: { kind: 'container', key: 'node:24', image: 'node' },
        },
        {
          depName: 'ghcr.io/example/untagged',
          currentDigest:
            'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          managerData: {
            kind: 'container',
            key: 'ghcr.io/example/untagged',
            image: 'ghcr.io/example/untagged',
          },
        },
        {
          depName: 'ghcr.io/github/gh-aw-firewall/agent',
          skipReason: 'internal-package',
        },
        {
          depName: 'ghcr.io/github/github-mcp-server',
          skipReason: 'internal-package',
        },
      ]);
    });

    it.each`
      repo                            | depName
      ${'github/gh-aw/actions/setup'} | ${'github/gh-aw'}
      ${'github/gh-aw-actions/setup'} | ${'github/gh-aw-actions'}
    `(
      'treats $repo as the CLI and takes its version',
      ({ repo, depName }: { repo: string; depName: string }) => {
        const content = JSON.stringify({
          entries: {
            [`${repo}@v0.45.5`]: {
              repo,
              version: 'v0.45.5',
              sha: '852cb06ad52958b402ed982b69957ffc57ca0619',
            },
          },
        });

        const res = extractPackageFile(content, packageFile);

        expect(res).toMatchObject({
          deps: [
            {
              depName,
              depType: 'gh-aw',
              commitMessageTopic: 'gh-aw CLI',
              currentValue: 'v0.45.5',
            },
          ],
        });
        expect(res?.deps[0]).not.toHaveProperty('skipReason');
        expect(getCompiledCliVersion(content)).toBe('v0.45.5');
      },
    );

    it('skips an image whose digest is invalid', () => {
      const content = JSON.stringify({
        entries: {},
        containers: {
          'node:24': { image: 'node:24', digest: 'sha256:short' },
        },
      });

      expect(extractPackageFile(content, packageFile)?.deps).toMatchObject([
        { depName: 'node', skipReason: 'invalid-value' },
      ]);
    });

    it('takes the newest CLI version when both setup actions are present', () => {
      const sha = '852cb06ad52958b402ed982b69957ffc57ca0619';
      const content = JSON.stringify({
        entries: {
          'github/gh-aw-actions/setup@v1.0.1': {
            repo: 'github/gh-aw-actions/setup',
            version: 'v1.0.1',
            sha,
          },
          'github/gh-aw/actions/setup@v0.9.0': {
            repo: 'github/gh-aw/actions/setup',
            version: 'v0.9.0',
            sha,
          },
        },
      });

      expect(getCompiledCliVersion(content)).toBe('v1.0.1');
    });

    it('does not upgrade the CLI with `binarySource=global`', () => {
      GlobalConfig.set({ binarySource: 'global' });
      const content = JSON.stringify({
        entries: {
          'github/gh-aw-actions/setup@v0.45.5': {
            repo: 'github/gh-aw-actions/setup',
            version: 'v0.45.5',
            sha: '852cb06ad52958b402ed982b69957ffc57ca0619',
          },
        },
      });

      expect(extractPackageFile(content, packageFile)?.deps).toMatchObject([
        { depType: 'gh-aw', skipReason: 'unsupported' },
      ]);
    });

    it('skips other actions released with the CLI without taking a version', () => {
      const content = JSON.stringify({
        entries: {
          'github/gh-aw-actions/other@v0.45.5': {
            repo: 'github/gh-aw-actions/other',
            version: 'v0.45.5',
            sha: '852cb06ad52958b402ed982b69957ffc57ca0619',
          },
        },
      });

      const res = extractPackageFile(content, packageFile);

      expect(res?.deps).toMatchObject([{ skipReason: 'internal-package' }]);
      expect(getCompiledCliVersion(content)).toBeUndefined();
    });
  });

  describe('getCompiledCliVersion()', () => {
    it('returns nothing for an invalid lockfile', () => {
      expect(getCompiledCliVersion('not json')).toBeUndefined();
    });
  });

  describe('workflow sources', () => {
    const sourceFile = '.github/workflows/triage.md';

    it('extracts the `uses:` pinned to a commit in the frontmatter', () => {
      const content = codeBlock`
        ---
        on: issues
        steps:
          - uses: actions/setup-node@v5
          - uses: 'actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8' # v5.0.0 pinned for safety
          - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # main
          - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
          - uses: github/gh-aw-actions/setup@5e508589e03a7757a7e05b26e834292f5445bfb6 # v0.88.7
          - uses: https://ghes.example.com/org/action@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v1
          - uses: ./local/action
          - uses: docker://node:24
          - run: echo
        ---
        - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
      `;

      expect(extractPackageFile(content, sourceFile)?.deps).toEqual([
        {
          depName: 'actions/checkout',
          commitMessageTopic: '{{{depName}}} action',
          depType: 'action',
          currentValue: 'v5.0.0',
          currentDigest: '08c6903cd8c0fde910a37f88322edcfb5dd907a8',
          datasource: 'github-tags',
          versioning: 'github-actions',
          managerData: { kind: 'source', repo: 'actions/checkout' },
        },
        {
          depName: 'actions/cache',
          commitMessageTopic: '{{{depName}}} action',
          depType: 'action',
          currentValue: 'main',
          currentDigest: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
          datasource: 'github-digest',
          versioning: 'exact',
          managerData: { kind: 'source', repo: 'actions/cache/restore' },
        },
        {
          depName: 'actions/github-script',
          commitMessageTopic: '{{{depName}}} action',
          depType: 'action',
          currentDigest: '3a2844b7e9c422d3c10d287c895573f7108da1b3',
          skipReason: 'unversioned-reference',
          managerData: { kind: 'source', repo: 'actions/github-script' },
        },
        expect.objectContaining({
          depName: 'github/gh-aw-actions',
          skipReason: 'internal-package',
        }),
      ]);
    });

    it.each`
      reason                        | content
      ${'no frontmatter'}           | ${'- uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0'}
      ${'an unclosed frontmatter'}  | ${'---\nsteps:\n  - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0'}
      ${'only tags in frontmatter'} | ${'---\nsteps:\n  - uses: actions/checkout@v5.0.0\n---\n'}
    `('returns null for $reason', ({ content }: { content: string }) => {
      expect(extractPackageFile(content, sourceFile)).toBeNull();
    });
  });
});
