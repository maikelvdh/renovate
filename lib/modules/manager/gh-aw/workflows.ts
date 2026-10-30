import { newlineRegex, regEx } from '../../../util/regex.ts';
import { isSha, parseUsesLine } from '../github-actions/parse.ts';
import type { ParsedUsesLine } from '../github-actions/types.ts';
import type { Upgrade } from '../types.ts';
import type {
  ActionManagerData,
  ContainerManagerData,
  GhAwManagerData,
  SourceManagerData,
} from './types.ts';

const digestRe = regEx(/^@sha256:[a-f0-9]{64}/);

/** The characters which can delimit an image reference in YAML. */
const imageDelimiters = new Set(['', ' ', '\t', '"', "'", ',', '[', ']']);

/** The `OWNER/REPO[/PATH]` of the updated action, which a replacement moves to another repository. */
export function getNewRepo(
  upgrade: Upgrade<GhAwManagerData>,
  data: ActionManagerData | SourceManagerData,
): string {
  if (!upgrade.newName || !upgrade.depName) {
    return data.repo;
  }
  // keep the path of an action in a subdirectory, i.e. the `/restore` of `actions/cache/restore`
  return `${upgrade.newName}${data.repo.slice(upgrade.depName.length)}`;
}

/** The image name of the updated container, which a replacement moves to another image. */
export function getNewImage(
  upgrade: Upgrade<GhAwManagerData>,
  data: ContainerManagerData,
): string {
  return upgrade.newName ?? data.image;
}

interface ActionUpdate {
  repo: string;
  newRepo: string;
  currentValue: string | null | undefined;
  currentDigest: string | undefined;
  newValue: string | undefined;
  newDigest: string;
}

interface ContainerUpdate {
  image: string;
  newImage: string;
  currentValue: string | null | undefined;
  newValue: string | null | undefined;
  newDigest: string;
}

/** The `OWNER/REPO[/PATH]` a `uses:` names, or `undefined` for a local or Docker reference. */
export function getUsesRepo(parsed: ParsedUsesLine): string | undefined {
  const ref = parsed.actionRef;
  if (ref?.kind !== 'repository' || ref.isExplicitHostname) {
    return undefined;
  }
  const path = ref.path ? `/${ref.path}` : '';
  return `${ref.owner}/${ref.repo}${path}`;
}

/** The new `uses:` value and comment, or `null` when the line does not reference the version being updated. */
function getNewReference(
  parsed: ParsedUsesLine,
  ref: string,
  update: ActionUpdate,
): { value: string; comment: string } | null {
  const { commentString, commentData } = parsed;
  if (!isSha(ref)) {
    if (!update.newValue || ref !== update.currentValue) {
      return null;
    }
    return {
      value: `${update.newRepo}@${update.newValue}`,
      comment: commentString,
    };
  }

  const commentVersion = commentData.pinnedVersion ?? commentData.ref;
  if (ref !== update.currentDigest && commentVersion !== update.currentValue) {
    return null;
  }
  // keep the rest of the comment, such as `# v7 pinned for X`, and only move the version
  let comment = commentString;
  if (update.newValue) {
    comment = commentVersion
      ? commentString.replace(commentVersion, update.newValue)
      : `# ${update.newValue}`;
  }
  return { value: `${update.newRepo}@${update.newDigest}`, comment };
}

function updateUsesLine(line: string, updates: ActionUpdate[]): string {
  const parsed = parseUsesLine(line);
  const repo = parsed && getUsesRepo(parsed);
  if (!parsed || !repo || parsed.actionRef?.kind !== 'repository') {
    return line;
  }

  const update = updates.find((candidate) => candidate.repo === repo);
  const newReference =
    update && getNewReference(parsed, parsed.actionRef.ref, update);
  if (!newReference) {
    return line;
  }

  const { usesPrefix, quote, replaceString, commentString } = parsed;
  const remainder = line.slice(usesPrefix.length);
  const value = remainder.replace(
    replaceString,
    `${quote}${newReference.value}${quote}`,
  );
  if (!commentString) {
    const separator = newReference.comment ? ' ' : '';
    return `${usesPrefix}${value}${separator}${newReference.comment}`;
  }
  const withoutComment = value.slice(0, value.length - commentString.length);
  return `${usesPrefix}${withoutComment}${newReference.comment}`;
}

function updateImageReferences(line: string, update: ContainerUpdate): string {
  const oldRef = update.currentValue
    ? `${update.image}:${update.currentValue}`
    : update.image;
  const newRef = update.newValue
    ? `${update.newImage}:${update.newValue}`
    : update.newImage;

  let result = '';
  let rest = line;
  for (
    let index = rest.indexOf(oldRef);
    index !== -1;
    index = rest.indexOf(oldRef)
  ) {
    let end = index + oldRef.length;
    const digest = digestRe.exec(rest.slice(end));
    if (digest) {
      end += digest[0].length;
    }

    const before = rest[index - 1] ?? '';
    const after = rest[end] ?? '';
    if (imageDelimiters.has(before) && imageDelimiters.has(after)) {
      const replacement = digest ? `${newRef}@${update.newDigest}` : newRef;
      result += `${rest.slice(0, index)}${replacement}`;
    } else {
      result += rest.slice(0, end);
    }
    rest = rest.slice(end);
  }
  return `${result}${rest}`;
}

/** The index of the line which closes the frontmatter, or `-1` when there is none. */
export function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') {
    return -1;
  }
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---');
}

function toActionUpdate(
  upgrade: Upgrade<GhAwManagerData>,
): ActionUpdate | null {
  const data = upgrade.managerData;
  if (
    (data?.kind !== 'action' && data?.kind !== 'source') ||
    !upgrade.newDigest
  ) {
    return null;
  }
  return {
    repo: data.repo,
    newRepo: getNewRepo(upgrade, data),
    currentValue: upgrade.currentValue,
    currentDigest: upgrade.currentDigest,
    newValue: upgrade.newValue ?? upgrade.currentValue ?? undefined,
    newDigest: upgrade.newDigest,
  };
}

function toContainerUpdate(
  upgrade: Upgrade<GhAwManagerData>,
): ContainerUpdate | null {
  const data = upgrade.managerData;
  if (data?.kind !== 'container' || !upgrade.newDigest) {
    return null;
  }
  return {
    image: data.image,
    newImage: getNewImage(upgrade, data),
    currentValue: upgrade.currentValue,
    newValue: upgrade.newValue ?? upgrade.currentValue,
    newDigest: upgrade.newDigest,
  };
}

/**
 * Apply the updated pins to the references in an agentic workflow source, as `gh aw update` and `gh aw upgrade` do.
 *
 * `gh aw compile` resolves a reference by the version written in the source, so without this the compiler would pin the old version back.
 * Actions are rewritten wherever a `uses:` names them, and images only within the frontmatter.
 */
export function updateWorkflowSource(
  content: string,
  upgrades: Upgrade<GhAwManagerData>[],
): string {
  const actions = upgrades
    .map(toActionUpdate)
    .filter((update) => update !== null);
  const containers = upgrades
    .map(toContainerUpdate)
    .filter((update) => update !== null);
  if (!actions.length && !containers.length) {
    return content;
  }

  const lines = content.split(newlineRegex);
  const lastFrontmatterLine = frontmatterEnd(lines);
  for (let index = 0; index < lines.length; index += 1) {
    let line = updateUsesLine(lines[index], actions);
    if (index < lastFrontmatterLine) {
      for (const update of containers) {
        line = updateImageReferences(line, update);
      }
    }
    lines[index] = line;
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return lines.join(newline);
}
