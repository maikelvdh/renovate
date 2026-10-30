import type { Category } from '../../../constants/index.ts';
import { DockerDatasource } from '../../datasource/docker/index.ts';
import { GithubDigestDatasource } from '../../datasource/github-digest/index.ts';
import { GithubTagsDatasource } from '../../datasource/github-tags/index.ts';

export { knownDepTypes } from './dep-types.ts';
export { extractPackageFile } from './extract.ts';
export { updateDependency } from './update.ts';

export const displayName = 'GitHub Agentic Workflows';
export const url = 'https://github.github.com/gh-aw/';
export const categories: Category[] = ['ci'];

export const supportsLockFileMaintenance = true;
export const lockFileNames = ['actions-lock.json'];
export const lockFileMaintenanceIsDelegatedToPackageManager = true;

export const defaultConfig = {
  managerFilePatterns: [
    '/^\\.github/aw/actions-lock\\.json$/',
    // the workflow sources, for the `uses:` pinned to a commit, which `actions-lock.json` does not record
    '/^\\.github/workflows/.+\\.md$/',
  ],
};

export const supportedDatasources = [
  DockerDatasource.id,
  GithubDigestDatasource.id,
  GithubTagsDatasource.id,
];
