import { isPlainObject } from '@sindresorhus/is';
import { logger } from '../../../logger/index.ts';
import type { UpdateDependencyConfig, Upgrade } from '../types.ts';
import { stringifyActionsLock } from './serialize.ts';
import type {
  GhAwManagerData,
  LockManagerData,
  SourceManagerData,
} from './types.ts';
import { getNewImage, getNewRepo, updateWorkflowSource } from './workflows.ts';

/** The fields `gh aw compile` caches from an action's `action.yml`, which describe the old commit once the pin moves. */
const commitMetadataFields = ['inputs', 'action_description'];

/** The section of `actions-lock.json` which holds the entry. */
export function getSection(data: LockManagerData): 'containers' | 'entries' {
  return data.kind === 'container' ? 'containers' : 'entries';
}

function getNewVersion(upgrade: Upgrade<GhAwManagerData>): string | undefined {
  return upgrade.newValue ?? upgrade.currentValue ?? undefined;
}

/** The key the updated entry is recorded under in `actions-lock.json`. */
export function getNewKey(
  upgrade: Upgrade<GhAwManagerData>,
  data: LockManagerData,
): string {
  const newVersion = getNewVersion(upgrade);
  if (data.kind === 'container') {
    const image = getNewImage(upgrade, data);
    return newVersion ? `${image}:${newVersion}` : image;
  }
  return `${getNewRepo(upgrade, data)}@${newVersion}`;
}

function getNewEntry(
  entry: Record<string, unknown>,
  upgrade: Upgrade<GhAwManagerData>,
  data: LockManagerData,
  newKey: string,
  newDigest: string,
): Record<string, unknown> {
  if (data.kind === 'container') {
    return {
      ...entry,
      image: newKey,
      digest: newDigest,
      pinned_image: `${newKey}@${newDigest}`,
    };
  }

  const updated: Record<string, unknown> = {
    ...entry,
    repo: getNewRepo(upgrade, data),
    version: getNewVersion(upgrade),
    sha: newDigest,
  };
  if (entry.sha !== newDigest) {
    for (const field of commitMetadataFields) {
      delete updated[field];
    }
  }
  return updated;
}

/** The commit or digest an entry is pinned to. */
function getPin(entry: unknown): unknown {
  return isPlainObject(entry) ? (entry.sha ?? entry.digest) : undefined;
}

/** Re-pin a `uses:` in a workflow source, which only the source records. */
function updateWorkflowSourcePin(
  fileContent: string,
  upgrade: Upgrade<GhAwManagerData>,
  data: SourceManagerData,
): string | null {
  const newContent = updateWorkflowSource(fileContent, [upgrade]);
  if (newContent !== fileContent) {
    return newContent;
  }
  // an existing branch already carries the update
  if (
    fileContent.includes(`${getNewRepo(upgrade, data)}@${upgrade.newDigest}`)
  ) {
    return fileContent;
  }
  logger.debug({ repo: data.repo }, 'gh-aw: reference not found');
  return null;
}

/** Re-key and re-pin the updated entry of `actions-lock.json`. */
function updateLockEntry(
  fileContent: string,
  upgrade: Upgrade<GhAwManagerData>,
  data: LockManagerData,
  newDigest: string,
): string | null {
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(fileContent);
  } catch (err) {
    logger.debug({ err }, 'gh-aw: failed to parse actions-lock.json');
    return null;
  }

  const section = getSection(data);
  if (!isPlainObject(lockfile) || !isPlainObject(lockfile[section])) {
    logger.debug({ section }, 'gh-aw: actions-lock.json has no such section');
    return null;
  }

  const entries = lockfile[section];
  const newKey = getNewKey(upgrade, data);
  const entry = entries[data.key];
  if (!isPlainObject(entry)) {
    // an existing branch already carries the update
    if (getPin(entries[newKey]) === newDigest) {
      return fileContent;
    }
    logger.debug({ key: data.key }, 'gh-aw: entry not found');
    return null;
  }

  delete entries[data.key];
  entries[newKey] = getNewEntry(entry, upgrade, data, newKey, newDigest);

  return stringifyActionsLock(lockfile);
}

/**
 * Re-pin the updated entry of `actions-lock.json`, or the updated `uses:` of a workflow source.
 *
 * `gh aw compile` then rewrites the workflows from the pins, in `updateArtifacts`.
 */
export function updateDependency({
  fileContent,
  upgrade,
}: UpdateDependencyConfig<GhAwManagerData>): string | null {
  const data = upgrade.managerData;
  if (!data) {
    logger.debug({ depName: upgrade.depName }, 'gh-aw: missing entry key');
    return null;
  }

  // without the new commit or digest the pin would point the new version at the old one
  if (!upgrade.newDigest) {
    logger.debug({ depName: upgrade.depName }, 'gh-aw: no new digest');
    return null;
  }

  if (data.kind === 'source') {
    return updateWorkflowSourcePin(fileContent, upgrade, data);
  }
  return updateLockEntry(fileContent, upgrade, data, upgrade.newDigest);
}
