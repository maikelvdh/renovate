import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import { newlineRegex, regEx } from '../../../util/regex.ts';
import { GithubDigestDatasource } from '../../datasource/github-digest/index.ts';
import { GithubTagsDatasource } from '../../datasource/github-tags/index.ts';
import * as exactVersioning from '../../versioning/exact/index.ts';
import * as githubActionsVersioning from '../../versioning/github-actions/index.ts';
import { getDep } from '../dockerfile/extract.ts';
import {
  isSha,
  parseUsesLine,
  versionLikeRe,
} from '../github-actions/parse.ts';
import type { PackageDependency, PackageFileContent } from '../types.ts';
import {
  cliDepType,
  ghAwNativeActionRe,
  ghAwNativeImageRe,
  ghAwSetupActionRe,
  workflowSourceFileRe,
} from './common.ts';
import {
  ActionsLock,
  type ActionsLockEntry,
  type ContainerLockEntry,
} from './schema.ts';
import type { GhAwManagerData } from './types.ts';
import { frontmatterEnd, getUsesRepo } from './workflows.ts';

const imageDigestRe = regEx(/^sha256:[a-f0-9]{64}$/);

/** Look a version up by its tags, and anything else, such as a branch, by its commit. */
function setDatasource(
  dep: PackageDependency<GhAwManagerData>,
  version: string,
): void {
  if (versionLikeRe.test(version)) {
    dep.datasource = GithubTagsDatasource.id;
    dep.versioning = githubActionsVersioning.id;
  } else {
    dep.datasource = GithubDigestDatasource.id;
    dep.versioning = exactVersioning.id;
  }
}

function extractAction(
  key: string,
  entry: ActionsLockEntry,
): PackageDependency<GhAwManagerData> {
  // `actions/cache/restore` is the `restore` action in the `actions/cache` repository
  const [owner, repo] = entry.repo.split('/');
  const dep: PackageDependency<GhAwManagerData> = {
    // the same name as the `github-actions` manager gives the `uses:` in the compiled workflow, so both updates land in one branch
    depName: `${owner}/${repo}`,
    commitMessageTopic: '{{{depName}}} action',
    depType: 'action',
    currentValue: entry.version,
    managerData: { kind: 'action', key, repo: entry.repo },
  };

  if (isSha(entry.sha)) {
    dep.currentDigest = entry.sha;
  } else {
    // without the commit there is nothing to re-pin, and no new commit to look up
    dep.skipReason = 'invalid-value';
  }

  setDatasource(dep, entry.version);

  if (ghAwSetupActionRe.test(entry.repo)) {
    // its releases are the releases of the CLI, so updating it upgrades the CLI
    dep.depType = cliDepType;
    dep.commitMessageTopic = 'gh-aw CLI';
    if (!dep.skipReason && GlobalConfig.get('binarySource') === 'global') {
      // the administrator provisions the CLI, and `gh aw compile` would pin the setup action straight back to their version
      dep.skipReason = 'unsupported';
    }
  } else if (!dep.skipReason && ghAwNativeActionRe.test(entry.repo)) {
    // released in lock-step with the CLI, which `gh aw compile` caps them at
    dep.skipReason = 'internal-package';
  }

  return dep;
}

/** Whether the entry is a setup action of a newer CLI than `version`, as a repository can hold both the current and the legacy setup action. */
function isNewerCli(
  entry: ActionsLockEntry,
  version: string | undefined,
): boolean {
  if (!ghAwSetupActionRe.test(entry.repo)) {
    return false;
  }
  return (
    !version ||
    githubActionsVersioning.api.isGreaterThan(entry.version, version)
  );
}

function extractContainer(
  key: string,
  entry: ContainerLockEntry,
): PackageDependency<GhAwManagerData> {
  const dep = getDep<GhAwManagerData>(entry.image, {
    specifyReplaceString: false,
    depType: 'container',
  });
  dep.currentDigest = entry.digest;
  if (!imageDigestRe.test(entry.digest)) {
    dep.skipReason = 'invalid-value';
  }

  const image = dep.currentValue
    ? entry.image.slice(0, -`:${dep.currentValue}`.length)
    : entry.image;
  dep.managerData = { kind: 'container', key, image };

  if (!dep.skipReason && ghAwNativeImageRe.test(entry.image)) {
    dep.skipReason = 'internal-package';
  }

  return dep;
}

function extractSourceAction(
  line: string,
): PackageDependency<GhAwManagerData> | null {
  const parsed = parseUsesLine(line);
  const repo = parsed && getUsesRepo(parsed);
  if (parsed?.actionRef?.kind !== 'repository' || !repo) {
    return null;
  }
  const { owner, repo: repoName, ref } = parsed.actionRef;
  // `actions-lock.json` records the commit a tag resolves to, so only a commit pin is ours to update here
  if (!isSha(ref)) {
    return null;
  }

  const { commentData } = parsed;
  const dep: PackageDependency<GhAwManagerData> = {
    depName: `${owner}/${repoName}`,
    commitMessageTopic: '{{{depName}}} action',
    depType: 'action',
    currentDigest: ref,
    managerData: { kind: 'source', repo },
  };

  const version = commentData.pinnedVersion ?? commentData.ref;
  if (version) {
    dep.currentValue = version;
    setDatasource(dep, version);
  } else {
    // without a `# VERSION` comment there is nothing to look a newer version up by
    dep.skipReason = 'unversioned-reference';
  }

  if (!dep.skipReason && ghAwNativeActionRe.test(repo)) {
    dep.skipReason = 'internal-package';
  }

  return dep;
}

/**
 * Extract the `uses:` pinned to a commit in the frontmatter of a workflow source.
 *
 * `gh aw compile` copies these into the compiled workflow as they are, without recording them in `actions-lock.json`.
 */
function extractWorkflowSource(
  content: string,
): PackageFileContent<GhAwManagerData> | null {
  const lines = content.split(newlineRegex);
  const deps = lines
    .slice(1, Math.max(frontmatterEnd(lines), 0))
    .map(extractSourceAction)
    .filter((dep) => dep !== null);
  return deps.length ? { deps } : null;
}

function extractActionsLock(
  content: string,
  packageFile: string,
): PackageFileContent<GhAwManagerData> | null {
  const parsed = ActionsLock.safeParse(content);
  if (!parsed.success) {
    logger.debug(
      { err: parsed.error, packageFile },
      `Failed to parse ${packageFile}`,
    );
    return null;
  }

  const deps: PackageDependency<GhAwManagerData>[] = [];
  for (const [key, entry] of Object.entries(parsed.data.entries)) {
    deps.push(extractAction(key, entry));
  }
  for (const [key, entry] of Object.entries(parsed.data.containers)) {
    deps.push(extractContainer(key, entry));
  }

  return deps.length ? { deps } : null;
}

/**
 * The version of the `gh aw` CLI which compiled the workflows, which `actions-lock.json` records as the version of its setup action.
 *
 * Renovate recompiles with it, so that an update does not also carry an unrelated CLI upgrade.
 */
export function getCompiledCliVersion(content: string): string | undefined {
  const parsed = ActionsLock.safeParse(content);
  if (!parsed.success) {
    return undefined;
  }
  let version: string | undefined;
  for (const entry of Object.values(parsed.data.entries)) {
    if (isNewerCli(entry, version)) {
      version = entry.version;
    }
  }
  return version;
}

export function extractPackageFile(
  content: string,
  packageFile: string,
): PackageFileContent<GhAwManagerData> | null {
  logger.trace(`gh-aw.extractPackageFile(${packageFile})`);

  if (workflowSourceFileRe.test(packageFile)) {
    return extractWorkflowSource(content);
  }
  return extractActionsLock(content, packageFile);
}
