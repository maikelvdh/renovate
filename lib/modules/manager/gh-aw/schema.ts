import { z } from 'zod/v4';
import { Json, LooseRecord } from '../../../util/schema-utils/index.ts';

const ActionsLockEntry = z.object({
  repo: z.string(),
  version: z.string(),
  sha: z.string(),
});
export type ActionsLockEntry = z.infer<typeof ActionsLockEntry>;

const ContainerLockEntry = z.object({
  image: z.string(),
  digest: z.string(),
});
export type ContainerLockEntry = z.infer<typeof ContainerLockEntry>;

/**
 * The `.github/aw/actions-lock.json` schema is owned by the `gh aw` CLI, so only the fields Renovate reads are validated.
 *
 * Actions are keyed by `OWNER/REPO[/PATH]@VERSION`, and containers by `IMAGE[:TAG]`.
 */
export const ActionsLock = Json.pipe(
  z.object({
    entries: LooseRecord(ActionsLockEntry),
    containers: LooseRecord(ContainerLockEntry).catch({}),
  }),
);
