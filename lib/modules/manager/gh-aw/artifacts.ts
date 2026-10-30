import { isPlainObject } from '@sindresorhus/is';
import { GlobalConfig } from '../../../config/global.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { readLocalFile, writeLocalFile } from '../../../util/fs/index.ts';
import { getFileList, getRepoStatus } from '../../../util/git/index.ts';
import type {
  FileAddition,
  FileChange,
  StatusResult,
} from '../../../util/git/types.ts';
import {
  getGhExtensionInstall,
  getGhTokenEnv,
} from '../../../util/github/gh-cli.ts';
import { regEx } from '../../../util/regex.ts';
import { api as semver } from '../../versioning/semver/index.ts';
import { actionsLockFile } from '../github-actions/common.ts';
import { ActionsLockfile } from '../github-actions/schema.ts';
import type { PackageFile, PostUpdateConfig, Upgrade } from '../types.ts';
import {
  artifactErrorMessageFromExecError,
  resolveToolConstraint,
} from '../util.ts';
import {
  actionsLockFileName,
  cliDepType,
  compiledWorkflowFileRe,
  workflowSourceFileRe,
} from './common.ts';
import { getCompiledCliVersion } from './extract.ts';
import type {
  AgenticWorkflowsResult,
  GhAwManagerData,
  LockManagerData,
} from './types.ts';
import { getNewKey, getSection } from './update.ts';
import { updateWorkflowSource } from './workflows.ts';

/** The `gh` CLI extension that compiles the agentic workflows. */
const extensionName = 'github/gh-aw';

/** The Copilot agent, setup steps and skill files which `gh aw upgrade` maintains. */
const agentFileRe = regEx(
  /^\.github\/(?:agents\/|skills\/|workflows\/copilot-setup-steps\.ya?ml$)/,
);

/** The manager whose upgrades and package files this compiles. */
const managerName = 'gh-aw';

/** What the branch asks of the CLI. */
type Mode = 'compile' | 'maintenance' | 'upgrade';

/** Rewrite the references to the updated pins in every workflow source. */
async function updateWorkflowSources(
  upgrades: Upgrade<GhAwManagerData>[],
): Promise<void> {
  const files = (await getFileList()).filter((file) =>
    workflowSourceFileRe.test(file),
  );
  for (const file of files) {
    const content = await readLocalFile(file, 'utf8');
    const newContent = content && updateWorkflowSource(content, upgrades);
    if (newContent && newContent !== content) {
      logger.debug(`gh-aw: updating references in ${file}`);
      await writeLocalFile(file, newContent);
    }
  }
}

/** The first `gh aw` release with `upgrade --no-agent --no-mcp --no-skill`. */
const minNoAgentFilesVersion = '0.92.4';

/** Whether `gh aw upgrade` at this release tag can be told to leave the agent files alone. Assumes so for the latest release. */
function supportsNoAgentFiles(version: string | undefined): boolean {
  return (
    !version ||
    !semver.isVersion(version) ||
    !semver.isGreaterThan(minNoAgentFilesVersion, version)
  );
}

function getCommand(mode: Mode, ghAwVersion: string | undefined): string {
  switch (mode) {
    case 'upgrade': {
      // `--skip-extension-upgrade`: stay on the CLI version we installed. It is hidden, as `gh aw` relaunches itself with it after upgrading itself, but is the only way to stop that. A release without it fails loudly with an unknown flag.
      // `--no-actions`: leave the other actions to their own updates
      const flags = ['--skip-extension-upgrade', '--no-actions'];
      if (supportsNoAgentFiles(ghAwVersion)) {
        // do not add or refresh the Copilot agent, setup steps and skill files, which a dependency update has no business creating
        flags.push('--no-agent', '--no-mcp', '--no-skill');
      }
      return `gh aw upgrade ${flags.join(' ')}`;
    }
    case 'maintenance':
      // re-resolve the digest of every recorded image tag, as it may have moved upstream.
      // Not `--force-refresh-action-pins`: it empties the cache, which drops pins newer than the CLI's own back to the CLI's version
      return 'gh aw compile --no-check-update --force-refresh-container-pins';
    case 'compile':
      // `--no-check-update`: do not ask whether a newer CLI is available, as the version is pinned
      return 'gh aw compile --no-check-update';
  }
}

/** The files `gh aw` writes, so other managers' files in the same branch are left to them. */
function isArtifact(path: string): boolean {
  return (
    path === actionsLockFileName ||
    compiledWorkflowFileRe.test(path) ||
    workflowSourceFileRe.test(path) ||
    // an upgrade before `--no-agent` refreshes these
    agentFileRe.test(path)
  );
}

async function getChangedFiles(
  status: StatusResult,
  writtenContent: Map<string, string>,
): Promise<FileChange[]> {
  const res: FileChange[] = [];

  for (const path of [...status.modified, ...status.not_added]) {
    if (isArtifact(path)) {
      const contents = await readLocalFile(path, 'utf8');
      // whatever this branch wrote is committed as a package file update already, so only what the tool changed on top of it is an artifact
      if (contents && contents !== writtenContent.get(path)) {
        res.push({ type: 'addition', path, contents });
      }
    }
  }

  for (const path of status.deleted.filter(isArtifact)) {
    res.push({ type: 'deletion', path });
  }

  return res;
}

/**
 * The updates which the compiler pinned back to their old version, because a workflow source still references it in a form we could not rewrite.
 *
 * Without this check, such an update would leave the compiled workflows untouched while the pull request claims it.
 */
async function getRevertedUpdates(
  upgrades: Upgrade<GhAwManagerData>[],
): Promise<string[]> {
  const content = await readLocalFile(actionsLockFileName, 'utf8');
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(content ?? '');
  } catch {
    return [];
  }
  if (!isPlainObject(lockfile)) {
    return [];
  }

  const reverted: string[] = [];
  for (const upgrade of upgrades) {
    const data = upgrade.managerData!;
    // a workflow source is not compiled back, so only the entries can revert
    if (isLockEntry(data)) {
      const section = lockfile[getSection(data)];
      if (
        isPlainObject(section) &&
        data.key !== getNewKey(upgrade, data) &&
        data.key in section
      ) {
        reverted.push(data.key);
      }
    }
  }
  return reverted;
}

function isLockEntry(data: GhAwManagerData): data is LockManagerData {
  return data.kind !== 'source';
}

/** The version of the CLI which compiled the workflows, as recorded by its setup action in `actions-lock.json`. */
async function getRecordedCliVersion(): Promise<string | undefined> {
  const content = await readLocalFile(actionsLockFileName, 'utf8');
  return content ? getCompiledCliVersion(content) : undefined;
}

/**
 * Whether `gh actions-lock` tracks a compiled workflow, whose entry has to follow the recompile.
 */
async function hasActionsLockedCompiledWorkflow(): Promise<boolean> {
  const content = await readLocalFile(actionsLockFile, 'utf8');
  const parsed = ActionsLockfile.safeParse(content);
  return (
    parsed.success &&
    Object.keys(parsed.data.workflows).some((workflow) =>
      compiledWorkflowFileRe.test(workflow),
    )
  );
}

/**
 * Recompile every agentic workflow once per branch, after all of the branch's package file updates have been written, as for `gh actions-lock`.
 *
 * The compiled `.lock.yml` workflows embed the pinned commits, along with a manifest of them, so they are regenerated by the tool rather than patched here.
 * Every workflow source and `actions-lock.json` feed into every compiled workflow, so compiling per package file would only repeat the same work.
 */
export async function updateAgenticWorkflows(
  config: PostUpdateConfig,
  packageFiles: Record<string, PackageFile[]> | undefined,
): Promise<AgenticWorkflowsResult> {
  const empty: AgenticWorkflowsResult = {
    updatedArtifacts: [],
    artifactErrors: [],
    artifactNotices: [],
  };

  const ghAwPackageFiles = packageFiles?.[managerName];
  // the `github-actions` manager regenerates `actions.lock` for the workflows we recompile, unless it is not enabled
  const regeneratesActionsLock = !!packageFiles?.['github-actions']?.length;
  if (!ghAwPackageFiles?.length) {
    return empty;
  }

  if (config.skipArtifactsUpdate) {
    logger.debug('Skipping compiling agentic workflows');
    return empty;
  }

  const ghAwPackageFilePaths = new Set(
    ghAwPackageFiles.map((file) => file.packageFile),
  );
  const updatedFiles = coerceArray(config.updatedPackageFiles).filter(
    (file): file is FileAddition =>
      file.type === 'addition' && ghAwPackageFilePaths.has(file.path),
  );

  const branchUpgrades = coerceArray(config.upgrades).filter(
    (upgrade) => upgrade.manager === managerName,
  ) as Upgrade<GhAwManagerData>[];
  const upgrades = branchUpgrades.filter((upgrade) => upgrade.managerData);
  // as for the other managers, lock file maintenance only runs for a fresh commit
  const isMaintenance =
    !config.reuseExistingBranch &&
    branchUpgrades.some(
      (upgrade) => upgrade.updateType === 'lockFileMaintenance',
    );
  // A reused branch which already carries its updates changes no package file, and compiling the base branch would only rebuild the branch on every run
  if (!isMaintenance && !(upgrades.length && updatedFiles.length)) {
    return empty;
  }

  // the compiled workflows need both, so do not compile a repository which only happens to have Markdown in `.github/workflows`
  if (!(await readLocalFile(actionsLockFileName, 'utf8'))) {
    logger.debug(`No ${actionsLockFileName} found, so not compiling`);
    return empty;
  }

  const cliUpgrade = upgrades.find((dep) => dep.depType === cliDepType);
  let mode: Mode = 'compile';
  if (isMaintenance) {
    mode = 'maintenance';
  } else if (cliUpgrade) {
    mode = 'upgrade';
  }

  // flush the branch's updates to disk, so the compiler reads them. Only the files this manager owns, as other managers' contents may be binary
  const writtenContent = new Map<string, string>();
  for (const file of updatedFiles) {
    const contents = file.contents!.toString();
    await writeLocalFile(file.path, contents);
    writtenContent.set(file.path, contents);
  }
  if (mode !== 'maintenance') {
    await updateWorkflowSources(upgrades);
  }

  const ghConstraint = await resolveToolConstraint(config, 'gh');
  // an upgrade installs the CLI version it upgrades to. Otherwise recompile with the CLI which generated the workflows, so the update does not also carry an unrelated CLI upgrade
  const ghAwConstraint =
    cliUpgrade?.newValue ??
    (await resolveToolConstraint(config, 'ghAw', getRecordedCliVersion));

  const commands = [getCommand(mode, ghAwConstraint)];
  const install = await getGhExtensionInstall(extensionName, ghAwConstraint);
  if (install) {
    commands.unshift(...install.commands);
  } else {
    logger.once.debug(
      { constraint: ghAwConstraint },
      'Not installing the `gh-aw` extension, and ignoring `constraints.ghAw`, because `binarySource=global` leaves tooling to the administrator',
    );
  }
  const env = { ...getGhTokenEnv(), ...install?.env };

  const execOptions: ExecOptions = {
    // the tool compiles every workflow, so it runs from the repository root
    cwd: GlobalConfig.get('localDir'),
    // force the token we resolved from the host rules, and the extension directory, over an ambient `GH_TOKEN` or `XDG_DATA_HOME`, as for `gh actions-lock`
    extraEnv: env,
    env,
    toolConstraints: [{ toolName: 'gh', constraint: ghConstraint }],
    docker: {},
  };

  try {
    await exec(commands, execOptions);
  } catch (err) {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err }, 'Error compiling agentic workflows');
    return {
      ...empty,
      artifactErrors: [
        {
          fileName: actionsLockFileName,
          stderr: artifactErrorMessageFromExecError(err, err.message),
        },
      ],
    };
  }

  const reverted = await getRevertedUpdates(upgrades);
  if (reverted.length) {
    return {
      ...empty,
      artifactErrors: [
        {
          fileName: actionsLockFileName,
          stderr: `\`gh aw compile\` pinned ${reverted.join(', ')} again, so a workflow source still references the old version in a form Renovate could not update. Update the reference by hand, or report it to Renovate.`,
        },
      ],
    };
  }

  const updatedArtifacts = await getChangedFiles(
    await getRepoStatus(),
    writtenContent,
  );
  if (!updatedArtifacts.length) {
    logger.debug('gh-aw: compiling left every workflow unchanged');
    return empty;
  }

  const artifactNotices = [];
  if (!regeneratesActionsLock && (await hasActionsLockedCompiledWorkflow())) {
    artifactNotices.push({
      file: actionsLockFile,
      message: `Renovate recompiled agentic workflows which \`${actionsLockFile}\` tracks, but did not regenerate it, as the \`github-actions\` manager is not enabled. Run \`gh actions-lock\` on this branch.`,
    });
  }

  return { updatedArtifacts, artifactErrors: [], artifactNotices };
}
