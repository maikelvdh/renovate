import { isPlainObject } from '@sindresorhus/is';
import { regEx } from '../../../util/regex.ts';

/** The characters Go's `encoding/json` escapes by default, which `JSON.stringify` leaves as they are. */
const goEscapeRe = regEx(/[<>&\u2028\u2029]/g);

const goEscapes: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** As Go's `json.MarshalIndent(value, "    ", "  ")`. */
function marshalIndent(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('\n', '\n    ')
    .replace(goEscapeRe, (char) => goEscapes[char]);
}

function marshalSection(
  name: string,
  section: Record<string, unknown>,
): string {
  const lines = Object.keys(section)
    .sort()
    .map((key) => `    "${key}": ${marshalIndent(section[key])}`);
  return `  "${name}": {\n${lines.join(',\n')}${lines.length ? '\n' : ''}  }`;
}

/**
 * Serialise `actions-lock.json` exactly as `gh aw` writes it, so an update only shows the entries it changed.
 *
 * This mirrors `ActionCache.marshalSorted` in gh-aw: entries sorted by key, the `containers` section only when it is not empty, Go's HTML escaping and a trailing newline.
 * Like gh-aw, it writes no other top-level fields.
 */
export function stringifyActionsLock(
  lockfile: Record<string, unknown>,
): string {
  const entries = isPlainObject(lockfile.entries) ? lockfile.entries : {};
  const sections = [marshalSection('entries', entries)];

  const containers = lockfile.containers;
  if (isPlainObject(containers) && Object.keys(containers).length) {
    sections.push(marshalSection('containers', containers));
  }

  return `{\n${sections.join(',\n')}\n}\n`;
}
