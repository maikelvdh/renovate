import { Fixtures } from '~test/fixtures.ts';
import { stringifyActionsLock } from './serialize.ts';

describe('modules/manager/gh-aw/serialize', () => {
  describe('stringifyActionsLock()', () => {
    // generated with Go's `encoding/json`, in the shape of gh-aw's `ActionCache.marshalSorted`
    it('writes a lockfile back byte for byte as gh-aw does', () => {
      const lockfile = Fixtures.get('actions-lock.json');

      expect(stringifyActionsLock(JSON.parse(lockfile))).toBe(lockfile);
    });

    it('sorts entries and escapes as Go does', () => {
      expect(
        stringifyActionsLock({
          entries: {
            'b@v1': { repo: 'b', description: '<a> & \u2028\u2029' },
            'a@v1': { repo: 'a' },
          },
        }),
      ).toBe(
        '{\n' +
          '  "entries": {\n' +
          '    "a@v1": {\n' +
          '      "repo": "a"\n' +
          '    },\n' +
          '    "b@v1": {\n' +
          '      "repo": "b",\n' +
          '      "description": "\\u003ca\\u003e \\u0026 \\u2028\\u2029"\n' +
          '    }\n' +
          '  }\n' +
          '}\n',
      );
    });

    it('writes empty entries, and omits empty containers and other fields, as gh-aw does', () => {
      expect(
        stringifyActionsLock({ entries: {}, containers: {}, other: true }),
      ).toBe('{\n  "entries": {\n  }\n}\n');
    });

    it('writes empty entries when they are missing', () => {
      expect(stringifyActionsLock({})).toBe('{\n  "entries": {\n  }\n}\n');
    });
  });
});
