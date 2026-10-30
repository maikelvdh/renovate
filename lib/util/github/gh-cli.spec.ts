import fs from 'fs-extra';
import { quote } from 'shlex';
import { type DirectoryResult, dir } from 'tmp-promise';
import upath from 'upath';
import { hostRules } from '~test/host-rules.ts';
import { GlobalConfig } from '../../config/global.ts';
import { toSha256 } from '../hash.ts';
import { getGhExtensionInstall, getGhTokenEnv } from './gh-cli.ts';

describe('util/github/gh-cli', () => {
  beforeEach(() => {
    GlobalConfig.reset();
  });

  describe('getGhTokenEnv()', () => {
    it('returns nothing without a token', () => {
      expect(getGhTokenEnv()).toEqual({});
    });

    it('passes a github.com token as `GH_TOKEN`', () => {
      hostRules.add({
        hostType: 'github',
        matchHost: 'api.github.com',
        token: 'some-token',
      });

      expect(getGhTokenEnv()).toEqual({ GH_TOKEN: 'some-token' });
    });

    it('passes a GHES token with its host, and the github.com token', () => {
      GlobalConfig.set({
        platform: 'github',
        endpoint: 'https://github.example.com/api/v3/',
      });
      hostRules.add({
        hostType: 'github',
        matchHost: 'github.example.com',
        token: 'ghes-token',
      });
      hostRules.add({
        hostType: 'github',
        matchHost: 'api.github.com',
        token: 'some-token',
      });

      expect(getGhTokenEnv()).toEqual({
        GH_HOST: 'github.example.com',
        GH_ENTERPRISE_TOKEN: 'ghes-token',
        GH_TOKEN: 'some-token',
      });
    });

    it('passes only the github.com token on GHES without a token of its own', () => {
      GlobalConfig.set({
        platform: 'github',
        endpoint: 'https://github.example.com/api/v3/',
      });
      hostRules.add({
        hostType: 'github',
        matchHost: 'api.github.com',
        token: 'some-token',
      });

      expect(getGhTokenEnv()).toEqual({ GH_TOKEN: 'some-token' });
    });

    it('ignores an endpoint of another platform', () => {
      GlobalConfig.set({
        platform: 'gitlab',
        endpoint: 'https://gitlab.example.com/api/v4/',
      });
      hostRules.add({
        hostType: 'github',
        matchHost: 'gitlab.example.com',
        token: 'other-token',
      });

      expect(getGhTokenEnv()).toEqual({});
    });
  });

  describe('getGhExtensionInstall()', () => {
    let cacheDir: DirectoryResult;

    beforeEach(async () => {
      cacheDir = await dir({ unsafeCleanup: true });
      GlobalConfig.set({ cacheDir: cacheDir.path });
    });

    afterEach(async () => {
      await cacheDir.cleanup();
    });

    function releaseDir(release: string): string {
      return upath.join(
        cacheDir.path,
        'others/gh-extensions/owner/ext',
        release,
      );
    }

    /** What `gh` leaves behind once it installed `tag`. */
    async function installed(release: string, tag: string): Promise<string> {
      const extDir = upath.join(releaseDir(release), 'gh/extensions/ext');
      const binary = upath.join(extDir, 'ext');
      await fs.outputFile(binary, '');
      await fs.outputFile(
        upath.join(extDir, 'manifest.yml'),
        `owner: owner\nname: ext\ntag: ${tag}\npath: ${binary}\n`,
      );
      return extDir;
    }

    async function usedDaysAgo(release: string, days: number): Promise<void> {
      const file = upath.join(releaseDir(release), '.last-used');
      await fs.outputFile(file, '');
      const time = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      await fs.utimes(file, time, time);
    }

    it('installs a release tag into a directory of its own', async () => {
      await expect(
        getGhExtensionInstall('owner/ext', 'v1.0.1'),
      ).resolves.toEqual({
        commands: ['gh extension install owner/ext --pin v1.0.1'],
        env: { XDG_DATA_HOME: releaseDir('v1.0.1') },
      });
      await expect(
        fs.pathExists(upath.join(releaseDir('v1.0.1'), '.last-used')),
      ).resolves.toBeTrue();
    });

    it('does not download a release which is installed already', async () => {
      await installed('v1.0.1', 'v1.0.1');

      await expect(
        getGhExtensionInstall('owner/ext', 'v1.0.1'),
      ).resolves.toMatchObject({ commands: [] });
    });

    it.each`
      reason                        | prepare
      ${'is empty'}                 | ${async () => fs.ensureDir(upath.join(releaseDir('v1.0.1'), 'gh/extensions/ext'))}
      ${'has no binary'}            | ${async () => fs.remove(upath.join(await installed('v1.0.1', 'v1.0.1'), 'ext'))}
      ${'holds another release'}    | ${async () => installed('v1.0.1', 'v2.0.0')}
      ${'points outside the cache'} | ${async () => fs.outputFile(upath.join(releaseDir('v1.0.1'), 'gh/extensions/ext/manifest.yml'), 'tag: v1.0.1\npath: /etc/passwd\n')}
    `(
      'reinstalls when the install $reason',
      async ({ prepare }: { prepare: () => Promise<unknown> }) => {
        await prepare();

        await expect(
          getGhExtensionInstall('owner/ext', 'v1.0.1'),
        ).resolves.toMatchObject({
          commands: ['gh extension install owner/ext --pin v1.0.1'],
        });
        await expect(
          fs.pathExists(upath.join(releaseDir('v1.0.1'), 'gh')),
        ).resolves.toBeFalse();
      },
    );

    it.each`
      version
      ${'v1 && x'}
      ${'../../etc'}
      ${'..'}
    `(
      'quotes $version, and keeps it out of the path',
      async ({ version }: { version: string }) => {
        const install = await getGhExtensionInstall('owner/ext', version);

        expect(install?.commands).toEqual([
          `gh extension install owner/ext --pin ${quote(version)}`,
        ]);
        expect(install?.env.XDG_DATA_HOME).toBe(releaseDir(toSha256(version)));
      },
    );

    it('upgrades to the latest release without one, and keeps a complete install', async () => {
      const extDir = await installed('latest', 'v0.9.0');

      await expect(
        getGhExtensionInstall('owner/ext', undefined),
      ).resolves.toEqual({
        commands: ['gh extension install owner/ext --force'],
        env: { XDG_DATA_HOME: releaseDir('latest') },
      });
      await expect(fs.pathExists(extDir)).resolves.toBeTrue();
    });

    it('removes the other releases which were not used for 30 days', async () => {
      await usedDaysAgo('v0.9.0', 31);
      await usedDaysAgo('v1.0.0', 29);
      await fs.ensureDir(releaseDir('v0.8.0'));
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await fs.utimes(releaseDir('v0.8.0'), old, old);
      await usedDaysAgo('v1.0.1', 31);

      await getGhExtensionInstall('owner/ext', 'v1.0.1');

      expect(
        (await fs.readdir(upath.dirname(releaseDir('v1.0.1')))).sort(),
      ).toEqual(['v1.0.0', 'v1.0.1']);
    });

    it('leaves the install to the administrator with `binarySource=global`', async () => {
      GlobalConfig.set({ cacheDir: cacheDir.path, binarySource: 'global' });

      await expect(
        getGhExtensionInstall('owner/ext', 'v1.0.1'),
      ).resolves.toBeNull();
      await expect(fs.pathExists(releaseDir('v1.0.1'))).resolves.toBeFalse();
    });
  });
});
