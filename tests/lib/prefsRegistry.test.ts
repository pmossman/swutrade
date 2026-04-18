import { describe, it, expect } from 'vitest';
import {
  PREF_DEFINITIONS,
  getPrefDefinition,
  validatePrefValue,
} from '../../lib/prefsRegistry.js';
import { users } from '../../lib/schema.js';

/**
 * Registry ↔ schema consistency. A registered pref that claims a
 * column that doesn't exist, or a default that disagrees with the
 * schema, would produce silent runtime bugs (writes that land in
 * the wrong column, reads that fall back to a mismatched literal).
 * These tests run in CI so drift fails the build.
 */
describe('prefsRegistry', () => {
  describe('shape invariants', () => {
    it('has no duplicate (key, scope) pairs — scope disambiguates same-key defs', () => {
      const seen = new Set<string>();
      for (const def of PREF_DEFINITIONS) {
        const composite = `${def.key}@${def.scope.kind}`;
        expect(seen.has(composite), `duplicate ${composite}`).toBe(false);
        seen.add(composite);
      }
    });

    it('every peer-scoped def has a matching self-scoped def with the same key, column, and enum options', () => {
      const peerDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'peer');
      for (const peerDef of peerDefs) {
        const selfDef = PREF_DEFINITIONS.find(
          d => d.scope.kind === 'self' && d.key === peerDef.key,
        );
        expect(selfDef, `peer def ${peerDef.key} has no self-scoped counterpart`).toBeTruthy();
        if (!selfDef) continue;
        // Column must match — the resolver falls back from peer table
        // to users.<column>, so divergence would write to the wrong
        // place.
        expect(peerDef.column).toBe(selfDef.column);
        // Type kind must agree.
        expect(peerDef.type.kind).toBe(selfDef.type.kind);
        // Enum options, if present, must match by value set — the
        // cascade resolver assumes any value storable in peer is
        // storable in self.
        if (peerDef.type.kind === 'enum' && selfDef.type.kind === 'enum') {
          const peerValues = new Set(peerDef.type.options.map(o => o.value));
          const selfValues = new Set(selfDef.type.options.map(o => o.value));
          expect(peerValues).toEqual(selfValues);
        }
        // Peer-scoped defs MUST default to null (sparse storage
        // invariant — a missing override inherits from self).
        expect(peerDef.default).toBeNull();
      }
    });

    it('every def declares web in surfaces — docs/prefs-registry.md requires web canonical', () => {
      for (const def of PREF_DEFINITIONS) {
        expect(def.surfaces).toContain('web');
      }
    });

    it('every Discord-surfaced enum has ≤ 5 options (one action row fits 5 buttons)', () => {
      for (const def of PREF_DEFINITIONS) {
        if (!def.surfaces.includes('discord')) continue;
        if (def.type.kind !== 'enum') continue;
        expect(def.type.options.length, `${def.key} has too many options for Discord`).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('self-scoped defs match the users schema', () => {
    // Cast to a record so dynamic-column access typechecks. The
    // runtime object exposes column objects under each camelCase
    // property name (verified: Object.keys(users) includes them).
    const usersColumns = users as unknown as Record<string, {
      default?: unknown;
      dataType?: string;
      enumValues?: readonly string[];
    }>;

    const selfDefs = PREF_DEFINITIONS.filter(d => d.scope.kind === 'self');

    it('has at least one self-scoped def (smoke — otherwise the loop below is a no-op)', () => {
      expect(selfDefs.length).toBeGreaterThan(0);
    });

    for (const def of selfDefs) {
      describe(def.key, () => {
        it('column exists on the users table', () => {
          expect(usersColumns[def.column]).toBeTruthy();
        });

        it('default matches the schema default', () => {
          expect(usersColumns[def.column]?.default).toBe(def.default);
        });

        if (def.type.kind === 'boolean') {
          it('schema column dataType is boolean', () => {
            expect(usersColumns[def.column]?.dataType).toBe('boolean');
          });
        }

        if (def.type.kind === 'enum') {
          it('registered enum options match the schema enumValues exactly', () => {
            const registered = new Set(def.type.kind === 'enum' ? def.type.options.map(o => o.value) : []);
            const schemaValues = new Set(usersColumns[def.column]?.enumValues ?? []);
            expect(registered, 'registered ⊆ schema').toEqual(schemaValues);
          });
        }
      });
    }
  });

  describe('getPrefDefinition', () => {
    it('finds a known (key, scope)', () => {
      const def = getPrefDefinition('communicationPref', 'self');
      expect(def?.column).toBe('communicationPref');
    });

    it('returns undefined for an unknown key', () => {
      expect(getPrefDefinition('no-such-pref', 'self')).toBeUndefined();
    });

    it('returns undefined for a known key at a scope where no def is registered', () => {
      // guild-scoped defs have a reserved slot in the scope union
      // but nothing is registered there yet — the lookup should miss.
      expect(getPrefDefinition('communicationPref', 'guild')).toBeUndefined();
    });
  });

  describe('validatePrefValue', () => {
    const boolDef = getPrefDefinition('dmTradeProposals', 'self')!;
    const enumDef = getPrefDefinition('communicationPref', 'self')!;

    it('accepts a matching boolean', () => {
      expect(validatePrefValue(boolDef, true)).toEqual({ ok: true, value: true });
      expect(validatePrefValue(boolDef, false)).toEqual({ ok: true, value: false });
    });

    it('rejects non-boolean for boolean prefs', () => {
      const r = validatePrefValue(boolDef, 'true');
      expect(r.ok).toBe(false);
    });

    it('accepts a known enum value', () => {
      expect(validatePrefValue(enumDef, 'allow')).toEqual({ ok: true, value: 'allow' });
    });

    it('rejects an unknown enum value', () => {
      const r = validatePrefValue(enumDef, 'nope');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/expected one of/);
    });

    it('rejects non-string for enum prefs', () => {
      const r = validatePrefValue(enumDef, 42);
      expect(r.ok).toBe(false);
    });

    it('rejects null — null is a peer-scope "clear override" signal handled elsewhere, not a value', () => {
      const r = validatePrefValue(boolDef, null);
      expect(r.ok).toBe(false);
    });
  });
});
