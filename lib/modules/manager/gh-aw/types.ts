import type { FileChange } from '../../../util/git/types.ts';
import type { ArtifactError, ArtifactNotice } from '../types.ts';

/** An entry in the `entries` section of `actions-lock.json`. */
export interface ActionManagerData {
  kind: 'action';
  /** The `OWNER/REPO[/PATH]@VERSION` key of the entry. */
  key: string;
  /** The `OWNER/REPO[/PATH]` of the action, as written in a `uses:`. */
  repo: string;
}

/** An entry in the `containers` section of `actions-lock.json`. */
export interface ContainerManagerData {
  kind: 'container';
  /** The `IMAGE[:TAG]` key of the entry. */
  key: string;
  /** The image name, without its tag. */
  image: string;
}

/** A `uses:` pinned to a commit in the frontmatter of a workflow source, which `actions-lock.json` does not record. */
export interface SourceManagerData {
  kind: 'source';
  /** The `OWNER/REPO[/PATH]` of the action, as written in the `uses:`. */
  repo: string;
}

/** An entry of `actions-lock.json`. */
export type LockManagerData = ActionManagerData | ContainerManagerData;

export type GhAwManagerData = LockManagerData | SourceManagerData;

/** The files, errors and notices of compiling the agentic workflows of a branch. */
export interface AgenticWorkflowsResult {
  updatedArtifacts: FileChange[];
  artifactErrors: ArtifactError[];
  artifactNotices: ArtifactNotice[];
}
