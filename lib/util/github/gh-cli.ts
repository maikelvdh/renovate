import { DateTime, Duration } from 'luxon';
import { quote } from 'shlex';
import { z } from 'zod/v4';
import { GlobalConfig } from '../../config/global.ts';
import { logger } from '../../logger/index.ts';
import { findGithubToken } from '../check-token.ts';
import { detectPlatform } from '../common.ts';
import type { ExtraEnv } from '../exec/types.ts';
import {
  cachePathIsFile,
  ensureCacheDir,
  listCacheDir,
  outputCacheFile,
  readCacheFile,
  rmCache,
  statCacheFile,
} from '../fs/index.ts';
import { toSha256 } from '../hash.ts';
import * as hostRules from '../host-rules.ts';
import { regEx } from '../regex.ts';
import { Yaml } from '../schema-utils/index.ts';
import { parseUrl } from '../url.ts';

const safeDirNameRe = regEx(/^[\w.+-]+$/);
const dotsOnlyRe = regEx(/^\.+$/);

function findToken(url: string): string | undefined {
  return findGithubToken(hostRules.find({ hostType: 'github', url }));
}

/**
 * The environment which authenticates the `gh` CLI, from the `github` host rules.
 *
 * `gh` takes the token from a different variable for GitHub Enterprise Server, and has to be told which host to talk to.
 * Public actions are still resolved against github.com from there, so pass a token for both hosts.
 */
export function getGhTokenEnv(): ExtraEnv {
  const githubComEndpoint = 'https://api.github.com/';
  const configuredEndpoint = GlobalConfig.get('endpoint');
  // The configured endpoint only says where GitHub lives when Renovate is talking to GitHub: workflows mirrored onto another platform still resolve their actions against github.com.
  const endpoint =
    configuredEndpoint && detectPlatform(configuredEndpoint) === 'github'
      ? configuredEndpoint
      : githubComEndpoint;

  const hostname = parseUrl(endpoint)?.hostname;
  const isEnterprise =
    !!hostname && hostname !== 'api.github.com' && hostname !== 'github.com';

  const env: ExtraEnv = {};

  if (isEnterprise) {
    const enterpriseToken = findToken(endpoint);
    if (enterpriseToken) {
      env.GH_HOST = hostname;
      env.GH_ENTERPRISE_TOKEN = enterpriseToken;
    }
  }

  const token = findToken(githubComEndpoint);
  if (token) {
    env.GH_TOKEN = token;
  }

  if (!Object.keys(env).length) {
    logger.debug('No GitHub token found for the `gh` CLI');
  }

  return env;
}

/** A `gh` CLI extension install, and the environment which points `gh` at it. */
export interface GhExtensionInstall {
  commands: string[];
  env: ExtraEnv;
}

/** Where the extensions are installed, below the cache directory, one directory per release tag. */
const extensionsDir = 'others/gh-extensions';

/** The file whose modification time records when a release was last used. */
const lastUsedFile = '.last-used';

/** How long an unused release is kept for. */
const maxUnused = Duration.fromObject({ days: 30 });

/** The part of `gh`'s record of an installed extension which says what it installed. */
const GhExtensionManifest = Yaml.pipe(
  z.object({ tag: z.string(), path: z.string() }),
);

/** A path segment for the release tag, which is user input. */
function toDirName(value: string): string {
  return safeDirNameRe.test(value) && !dotsOnlyRe.test(value)
    ? value
    : toSha256(value);
}

/** Whether `gh` finished installing the release, as an interrupted install leaves behind a directory which `gh` takes for an installed extension. */
async function isInstalled(
  installDir: string,
  extension: string,
  version: string | undefined,
): Promise<boolean> {
  const name = extension.split('/').pop()!;
  try {
    const manifest = GhExtensionManifest.safeParse(
      await readCacheFile(
        `${installDir}/gh/extensions/${name}/manifest.yml`,
        'utf8',
      ),
    );
    return (
      manifest.success &&
      (!version || manifest.data.tag === version) &&
      (await cachePathIsFile(manifest.data.path))
    );
  } catch {
    return false;
  }
}

/** Remove the other releases of the extension which no repository has used for a while, as each is a full binary. */
async function pruneUnusedReleases(
  extensionDir: string,
  release: string,
): Promise<void> {
  const unusedSince = DateTime.utc().minus(maxUnused);
  // the directory exists, as the release being installed is in it
  const releases = await listCacheDir(extensionDir);
  for (const other of releases.filter((name) => name !== release)) {
    const dir = `${extensionDir}/${other}`;
    const stat =
      (await statCacheFile(`${dir}/${lastUsedFile}`)) ??
      (await statCacheFile(dir));
    if (!stat || DateTime.fromJSDate(stat.mtime) < unusedSince) {
      logger.debug(`Removing the unused ${dir}`);
      await rmCache(dir);
    }
  }
}

/**
 * Install a `gh` CLI extension at a release tag, or the latest release without one.
 *
 * Every release tag is installed into a directory of its own below the cache directory, which `XDG_DATA_HOME` points `gh` at, as `gh extension install --force --pin` upgrades an installed extension to the latest release rather than to the pin.
 * A release is only downloaded once, and releases which have not been used for a while are removed.
 *
 * Returns `null` with `binarySource=global`, where the administrator provisions tooling, so we must not reach into their `gh` install to add or re-pin an extension.
 */
export async function getGhExtensionInstall(
  extension: string,
  version: string | undefined,
): Promise<GhExtensionInstall | null> {
  if (GlobalConfig.get('binarySource') === 'global') {
    return null;
  }

  const extensionDir = `${extensionsDir}/${extension
    .split('/')
    .map(toDirName)
    .join('/')}`;
  const release = version ? toDirName(version) : 'latest';
  const installDir = `${extensionDir}/${release}`;
  const env = {
    XDG_DATA_HOME: await ensureCacheDir(installDir.slice('others/'.length)),
  };

  await pruneUnusedReleases(extensionDir, release);
  await outputCacheFile(
    `${installDir}/${lastUsedFile}`,
    DateTime.utc().toISO(),
  );

  const isComplete = await isInstalled(installDir, extension, version);
  if (!isComplete) {
    // clear whatever an interrupted install left behind, which `gh` would refuse to install over
    await rmCache(`${installDir}/gh`);
  }

  if (!version) {
    // `--force` upgrades an installed extension to the latest release
    return {
      commands: [`gh extension install ${extension} --force`],
      env,
    };
  }
  return {
    commands: isComplete
      ? []
      : [`gh extension install ${extension} --pin ${quote(version)}`],
    env,
  };
}
