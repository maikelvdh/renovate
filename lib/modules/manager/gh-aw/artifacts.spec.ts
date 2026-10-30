import { mockExecAll } from '~test/exec-util.ts';
import { hostRules } from '~test/host-rules.ts';
import { fs, git, logger, partial } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type {
  InternalGlobalConfigOptions,
  RepoGlobalConfig,
} from '../../../config/types.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import type { FileChange, StatusResult } from '../../../util/git/types.ts';
import type { PackageFile, PostUpdateConfig, Upgrade } from '../types.ts';
import { updateAgenticWorkflows } from './artifacts.ts';
import type { GhAwManagerData } from './types.ts';

vi.mock('../../../util/fs/index.ts');

const lockFileName = '.github/aw/actions-lock.json';
const compiledWorkflow = '.github/workflows/triage.lock.yml';
const workflowSource = '.github/workflows/triage.md';
const actionsLock = '.github/workflows/actions.lock';

const newSha = '1111111111111111111111111111111111111111';
const newLockContent = `${JSON.stringify({
  entries: {
    'actions/checkout@v8': {
      repo: 'actions/checkout',
      version: 'v8',
      sha: newSha,
    },
  },
})}\n`;

const adminConfig: RepoGlobalConfig & InternalGlobalConfigOptions = {
  localDir: '/tmp/github/some/repo',
  cacheDir: '/tmp/cache',
};

const checkoutUpgrade: Upgrade<GhAwManagerData> = {
  manager: 'gh-aw',
  packageFile: lockFileName,
  depName: 'actions/checkout',
  depType: 'action',
  currentValue: 'v7',
  newValue: 'v8',
  newDigest: newSha,
  managerData: {
    kind: 'action',
    key: 'actions/checkout@v7',
    repo: 'actions/checkout',
  },
};

const cliUpgrade: Upgrade<GhAwManagerData> = {
  manager: 'gh-aw',
  packageFile: lockFileName,
  depName: 'github/gh-aw-actions',
  depType: 'gh-aw',
  currentValue: 'v1.0.1',
  newValue: 'v1.1.0',
  newDigest: '2222222222222222222222222222222222222222',
  managerData: {
    kind: 'action',
    key: 'github/gh-aw-actions/setup@v1.0.1',
    repo: 'github/gh-aw-actions/setup',
  },
};

const maintenanceUpgrade: Upgrade<GhAwManagerData> = {
  manager: 'gh-aw',
  packageFile: lockFileName,
  updateType: 'lockFileMaintenance',
};

const packageFiles: Record<string, PackageFile[]> = {
  'gh-aw': [
    { packageFile: lockFileName, deps: [] },
    { packageFile: workflowSource, deps: [] },
  ],
};

function makeConfig(
  config: Partial<PostUpdateConfig> = {},
  upgrades: Upgrade<GhAwManagerData>[] = [checkoutUpgrade],
): PostUpdateConfig {
  return {
    branchName: 'renovate/actions-checkout-8.x',
    upgrades,
    updatedPackageFiles: [
      { type: 'addition', path: lockFileName, contents: newLockContent },
    ],
    ...config,
  };
}

/** The files on disk, by path. The lockfile defaults to what Renovate wrote. */
function mockFiles(files: Record<string, string | null> = {}): void {
  const contents: Record<string, string | null> = {
    [lockFileName]: newLockContent,
    ...files,
  };
  fs.readLocalFile.mockImplementation((path: string) =>
    Promise.resolve(contents[path] ?? null),
  );
}

function mockRepoStatus(status: Partial<StatusResult> = {}): void {
  git.getRepoStatus.mockResolvedValue(
    partial<StatusResult>({
      modified: [],
      not_added: [],
      deleted: [],
      ...status,
    }),
  );
}

function addition(path: string, contents: string): FileChange {
  return { type: 'addition', path, contents };
}

function installDir(version: string): string {
  return `/tmp/cache/others/gh-extensions/github/gh-aw/${version}`;
}

describe('modules/manager/gh-aw/artifacts', () => {
  beforeEach(() => {
    GlobalConfig.set(adminConfig);
    git.getFileList.mockResolvedValue([]);
    fs.ensureCacheDir.mockImplementation((name: string) =>
      Promise.resolve(`/tmp/cache/others/${name}`),
    );
    fs.listCacheDir.mockResolvedValue([]);
    mockFiles();
    mockRepoStatus();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('updateAgenticWorkflows()', () => {
    it.each`
      reason                                  | files           | config                           | upgrades
      ${'without gh-aw package files'}        | ${{}}           | ${{}}                            | ${[checkoutUpgrade]}
      ${'when artifacts updates are skipped'} | ${packageFiles} | ${{ skipArtifactsUpdate: true }} | ${[checkoutUpgrade]}
      ${'without gh-aw upgrades'}             | ${packageFiles} | ${{}}                            | ${[{ ...checkoutUpgrade, manager: 'npm' }, { manager: 'gh-aw' }]}
      ${'for maintenance of a reused branch'} | ${packageFiles} | ${{ reuseExistingBranch: true }} | ${[maintenanceUpgrade]}
    `(
      'does nothing $reason',
      async ({
        files,
        config,
        upgrades,
      }: {
        files: Record<string, PackageFile[]>;
        config: Partial<PostUpdateConfig>;
        upgrades: Upgrade<GhAwManagerData>[];
      }) => {
        const execSnapshots = mockExecAll();

        await expect(
          updateAgenticWorkflows(makeConfig(config, upgrades), files),
        ).resolves.toEqual({
          updatedArtifacts: [],
          artifactErrors: [],
          artifactNotices: [],
        });
        expect(execSnapshots).toBeEmpty();
      },
    );

    it('does not compile a repository without `actions-lock.json`', async () => {
      const execSnapshots = mockExecAll();
      mockFiles({ [lockFileName]: null });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toMatchObject({ updatedArtifacts: [] });
      expect(execSnapshots).toBeEmpty();
      expect(fs.writeLocalFile).not.toHaveBeenCalled();
    });
  });

  describe('compiling', () => {
    it('writes the branch updates, compiles once, and returns only the files gh-aw owns', async () => {
      const execSnapshots = mockExecAll();
      const source = '---\nsteps:\n  - uses: actions/checkout@v8\n---\n';
      mockFiles({
        [compiledWorkflow]: 'compiled workflow',
        [workflowSource]: source,
      });
      mockRepoStatus({
        modified: [
          lockFileName,
          workflowSource,
          compiledWorkflow,
          'gradle/wrapper/gradle-wrapper.jar',
        ],
        not_added: ['untracked.txt'],
        deleted: ['.github/workflows/old.lock.yml', 'other.txt'],
      });

      const res = await updateAgenticWorkflows(
        makeConfig({
          constraints: { ghAw: 'v1.0.1' },
          updatedPackageFiles: [
            addition(lockFileName, newLockContent),
            addition(workflowSource, source),
            addition('gradle/wrapper/gradle-wrapper.jar', 'binary'),
            { type: 'deletion', path: 'removed.txt' },
          ],
        }),
        packageFiles,
      );

      expect(fs.writeLocalFile).toHaveBeenCalledWith(
        lockFileName,
        newLockContent,
      );
      expect(fs.writeLocalFile).toHaveBeenCalledWith(workflowSource, source);
      expect(fs.writeLocalFile).toHaveBeenCalledTimes(2);
      // what the branch wrote is committed as package file updates already
      expect(res).toEqual({
        updatedArtifacts: [
          addition(compiledWorkflow, 'compiled workflow'),
          { type: 'deletion', path: '.github/workflows/old.lock.yml' },
        ],
        artifactErrors: [],
        artifactNotices: [],
      });
      expect(execSnapshots).toMatchObject([
        {
          cmd: 'gh extension install github/gh-aw --pin v1.0.1',
          options: {
            cwd: '/tmp/github/some/repo',
            env: { XDG_DATA_HOME: installDir('v1.0.1') },
          },
        },
        {
          cmd: 'gh aw compile --no-check-update',
          options: {
            cwd: '/tmp/github/some/repo',
            env: { XDG_DATA_HOME: installDir('v1.0.1') },
          },
        },
      ]);
    });

    it('rewrites the references in the workflow sources', async () => {
      mockExecAll();
      git.getFileList.mockResolvedValue([
        workflowSource,
        '.github/workflows/shared/unchanged.md',
        '.github/workflows/shared/empty.md',
        '.github/workflows/ci.yml',
        'docs/readme.md',
      ]);
      mockFiles({
        [workflowSource]: '  - uses: actions/checkout@v7\n',
        '.github/workflows/shared/unchanged.md': 'no references\n',
      });

      await updateAgenticWorkflows(makeConfig(), packageFiles);

      expect(fs.writeLocalFile).toHaveBeenCalledWith(
        workflowSource,
        '  - uses: actions/checkout@v8\n',
      );
      expect(fs.writeLocalFile).toHaveBeenCalledTimes(2);
    });

    it('returns the lockfile when the compiler rewrote it', async () => {
      mockExecAll();
      const rewritten = newLockContent.replace('}}', ', "x": 1}}');
      mockFiles({ [lockFileName]: rewritten });
      mockRepoStatus({ modified: [lockFileName] });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toMatchObject({
        updatedArtifacts: [addition(lockFileName, rewritten)],
      });
    });

    it('returns nothing when nothing changed', async () => {
      mockExecAll();
      mockRepoStatus({ modified: [lockFileName] });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toEqual({
        updatedArtifacts: [],
        artifactErrors: [],
        artifactNotices: [],
      });
    });

    it('recompiles with the CLI which `actions-lock.json` records', async () => {
      const execSnapshots = mockExecAll();
      mockFiles({
        [lockFileName]: JSON.stringify({
          entries: {
            'github/gh-aw-actions/setup@v0.88.7': {
              repo: 'github/gh-aw-actions/setup',
              version: 'v0.88.7',
              sha: '5e508589e03a7757a7e05b26e834292f5445bfb6',
            },
          },
        }),
      });

      await updateAgenticWorkflows(makeConfig(), packageFiles);

      expect(execSnapshots[0].cmd).toBe(
        'gh extension install github/gh-aw --pin v0.88.7',
      );
    });

    it('installs the latest CLI when nothing records a version', async () => {
      const execSnapshots = mockExecAll();

      await updateAgenticWorkflows(makeConfig(), packageFiles);

      expect(execSnapshots[0]).toMatchObject({
        cmd: 'gh extension install github/gh-aw --force',
        options: { env: { XDG_DATA_HOME: installDir('latest') } },
      });
    });
  });

  describe('workflow sources', () => {
    const oldSha = '08c6903cd8c0fde910a37f88322edcfb5dd907a8';
    const newSource = `---\nsteps:\n  - uses: actions/checkout@${newSha} # v8\n---\n`;
    const sourceUpgrade: Upgrade<GhAwManagerData> = {
      manager: 'gh-aw',
      packageFile: workflowSource,
      depName: 'actions/checkout',
      depType: 'action',
      currentValue: 'v7',
      currentDigest: oldSha,
      newValue: 'v8',
      newDigest: newSha,
      managerData: { kind: 'source', repo: 'actions/checkout' },
    };

    it('compiles a branch which only updates a workflow source', async () => {
      const execSnapshots = mockExecAll();
      mockFiles({
        [workflowSource]: newSource,
        [compiledWorkflow]: 'compiled workflow',
      });
      mockRepoStatus({ modified: [workflowSource, compiledWorkflow] });

      const res = await updateAgenticWorkflows(
        makeConfig(
          { updatedPackageFiles: [addition(workflowSource, newSource)] },
          [sourceUpgrade],
        ),
        packageFiles,
      );

      expect(execSnapshots.at(-1)?.cmd).toBe('gh aw compile --no-check-update');
      expect(res.updatedArtifacts).toEqual([
        addition(compiledWorkflow, 'compiled workflow'),
      ]);
    });

    it('does not check a workflow source for reverted pins', async () => {
      mockExecAll();
      mockFiles({
        [lockFileName]: JSON.stringify({
          entries: { 'actions/checkout@v7': {} },
        }),
        [compiledWorkflow]: 'compiled workflow',
      });
      mockRepoStatus({ modified: [compiledWorkflow] });

      const res = await updateAgenticWorkflows(
        makeConfig({}, [sourceUpgrade]),
        packageFiles,
      );

      expect(res.artifactErrors).toBeEmpty();
    });
  });

  describe('verifying', () => {
    it('reports an update which the compiler pinned back', async () => {
      mockExecAll();
      mockFiles({
        [lockFileName]: JSON.stringify({
          entries: {
            'actions/checkout@v7': {},
            'actions/checkout@v8': {},
          },
        }),
      });
      mockRepoStatus({ modified: [lockFileName] });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toEqual({
        updatedArtifacts: [],
        artifactErrors: [
          {
            fileName: lockFileName,
            stderr: expect.stringContaining(
              '`gh aw compile` pinned actions/checkout@v7 again',
            ),
          },
        ],
        artifactNotices: [],
      });
    });

    it('accepts a digest-only update, whose key does not change', async () => {
      mockExecAll();
      mockFiles({
        [lockFileName]: JSON.stringify({
          entries: { 'actions/checkout@v7': {} },
        }),
        [compiledWorkflow]: 'compiled workflow',
      });
      mockRepoStatus({ modified: [compiledWorkflow] });

      const res = await updateAgenticWorkflows(
        makeConfig({}, [{ ...checkoutUpgrade, newValue: undefined }]),
        packageFiles,
      );

      expect(res.updatedArtifacts).toMatchObject([{ path: compiledWorkflow }]);
    });

    it.each`
      reason                | content
      ${'is not JSON'}      | ${'not json'}
      ${'has no section'}   | ${'{}'}
      ${'is not an object'} | ${'[]'}
    `(
      'skips the check when the lockfile $reason',
      async ({ content }: { content: string }) => {
        mockExecAll();
        mockFiles({
          [lockFileName]: content,
          [compiledWorkflow]: 'compiled workflow',
        });
        mockRepoStatus({ modified: [compiledWorkflow] });

        await expect(
          updateAgenticWorkflows(makeConfig(), packageFiles),
        ).resolves.toMatchObject({
          updatedArtifacts: [{ path: compiledWorkflow }],
          artifactErrors: [],
        });
      },
    );
  });

  describe('actions.lock', () => {
    it('leaves it to the `github-actions` manager, which regenerates it', async () => {
      mockExecAll();
      mockFiles({
        [compiledWorkflow]: 'compiled workflow',
        [actionsLock]: `workflows:\n  '${compiledWorkflow}': []\n`,
      });
      mockRepoStatus({ modified: [compiledWorkflow] });

      await expect(
        updateAgenticWorkflows(makeConfig(), {
          ...packageFiles,
          'github-actions': [{ packageFile: compiledWorkflow, deps: [] }],
        }),
      ).resolves.toMatchObject({
        updatedArtifacts: [{ path: compiledWorkflow }],
        artifactNotices: [],
      });
    });

    it('tells the user to regenerate it when the `github-actions` manager is not enabled', async () => {
      mockExecAll();
      mockFiles({
        [compiledWorkflow]: 'compiled workflow',
        [actionsLock]: `workflows:\n  '${compiledWorkflow}': []\n`,
      });
      mockRepoStatus({ modified: [compiledWorkflow] });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toEqual({
        updatedArtifacts: [addition(compiledWorkflow, 'compiled workflow')],
        artifactErrors: [],
        artifactNotices: [
          {
            file: actionsLock,
            message: expect.stringContaining('Run `gh actions-lock`'),
          },
        ],
      });
    });

    it('says nothing when it only tracks other workflows', async () => {
      mockExecAll();
      mockFiles({
        [compiledWorkflow]: 'compiled workflow',
        [actionsLock]: `workflows:\n  '.github/workflows/ci.yml': []\n`,
      });
      mockRepoStatus({ modified: [compiledWorkflow] });

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toMatchObject({ artifactNotices: [] });
    });
  });

  describe('upgrading the CLI', () => {
    it('installs the new CLI and upgrades without adding agent files', async () => {
      const execSnapshots = mockExecAll();
      mockFiles({ [compiledWorkflow]: 'compiled workflow' });
      mockRepoStatus({
        modified: [compiledWorkflow],
        not_added: ['.github/skills/agentic-workflows/SKILL.md'],
      });

      const res = await updateAgenticWorkflows(
        makeConfig({ constraints: { ghAw: 'v1.0.1' } }, [
          cliUpgrade,
          checkoutUpgrade,
        ]),
        packageFiles,
      );

      expect(execSnapshots.map((s) => s.cmd)).toEqual([
        'gh extension install github/gh-aw --pin v1.1.0',
        'gh aw upgrade --skip-extension-upgrade --no-actions --no-agent --no-mcp --no-skill',
      ]);
      expect(res.updatedArtifacts).toEqual([
        addition(compiledWorkflow, 'compiled workflow'),
      ]);
    });

    it('lets an upgrade before v0.92.4 refresh the agent files, which it cannot be told to skip', async () => {
      const execSnapshots = mockExecAll();
      const skill = '.github/skills/agentic-workflows/SKILL.md';
      mockFiles({ [skill]: 'skill' });
      mockRepoStatus({
        modified: ['.github/workflows/copilot-setup-steps.yml'],
        not_added: [skill, 'unrelated.txt'],
      });

      const res = await updateAgenticWorkflows(
        makeConfig({}, [{ ...cliUpgrade, newValue: 'v0.92.3' }]),
        packageFiles,
      );

      expect(execSnapshots.at(-1)?.cmd).toBe(
        'gh aw upgrade --skip-extension-upgrade --no-actions',
      );
      expect(res.updatedArtifacts).toEqual([addition(skill, 'skill')]);
    });
  });

  describe('lock file maintenance', () => {
    it('refreshes the image digests without touching the workflow sources', async () => {
      const execSnapshots = mockExecAll();
      const refreshed = '{"entries":{"refreshed":true}}\n';
      mockFiles({ [lockFileName]: refreshed });
      mockRepoStatus({ modified: [lockFileName] });

      const res = await updateAgenticWorkflows(
        makeConfig({ updatedPackageFiles: [] }, [maintenanceUpgrade]),
        packageFiles,
      );

      expect(git.getFileList).not.toHaveBeenCalled();
      expect(execSnapshots.map((s) => s.cmd)).toEqual([
        'gh extension install github/gh-aw --force',
        'gh aw compile --no-check-update --force-refresh-container-pins',
      ]);
      expect(res.updatedArtifacts).toEqual([addition(lockFileName, refreshed)]);
    });
  });

  describe('tooling and credentials', () => {
    it('does not touch the extension with `binarySource=global`', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'global' });
      const execSnapshots = mockExecAll();

      await updateAgenticWorkflows(
        makeConfig({ constraints: { ghAw: 'v1.0.1' } }),
        packageFiles,
      );

      expect(execSnapshots.map((s) => s.cmd)).toEqual([
        'gh aw compile --no-check-update',
      ]);
      expect(execSnapshots[0].options?.env).not.toHaveProperty('XDG_DATA_HOME');
    });

    it('passes the `gh` constraint and a token', async () => {
      vi.stubEnv('CONTAINERBASE', 'true');
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      hostRules.add({
        hostType: 'github',
        matchHost: 'api.github.com',
        token: 'some-token',
      });
      const execSnapshots = mockExecAll();

      await updateAgenticWorkflows(
        makeConfig({ constraints: { gh: '2.62.0' } }),
        packageFiles,
      );

      expect(execSnapshots.map((s) => s.cmd)).toContain(
        'install-tool gh 2.62.0',
      );
      expect(execSnapshots.at(-1)?.options?.env).toMatchObject({
        GH_TOKEN: 'some-token',
      });
    });
  });

  describe('errors', () => {
    it('reports a compile failure', async () => {
      mockExecAll(new Error('compile failed'));

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).resolves.toEqual({
        updatedArtifacts: [],
        artifactErrors: [
          { fileName: lockFileName, stderr: expect.any(String) },
        ],
        artifactNotices: [],
      });
      expect(logger.logger.debug).toHaveBeenCalledWith(
        expect.anything(),
        'Error compiling agentic workflows',
      );
    });

    it('rethrows a temporary error', async () => {
      mockExecAll(new Error(TEMPORARY_ERROR));

      await expect(
        updateAgenticWorkflows(makeConfig(), packageFiles),
      ).rejects.toThrow(TEMPORARY_ERROR);
    });
  });
});
