/**
 * The published policy and the enforced policy must be the same document.
 *
 * This test regenerates REFUND_POLICY.md from the live rule objects and
 * compares it to the file on disk. Editing a rule without regenerating fails
 * here, which is the point: the `policyRef` on every decision is only
 * meaningful if the clause it points at exists and says what the rule does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POLICY_RULES } from '../policy/rules/index.js';
import { renderPolicyDocument } from '../policy/policyDocument.js';

const DOC_PATH = fileURLToPath(new URL('../../../../REFUND_POLICY.md', import.meta.url));

describe('REFUND_POLICY.md', () => {
  it('matches the code that enforces it', () => {
    const onDisk = readFileSync(DOC_PATH, 'utf8');
    expect(onDisk).toBe(renderPolicyDocument());
  });

  it('has a clause for every rule policyRef', () => {
    const onDisk = readFileSync(DOC_PATH, 'utf8');
    const missing = POLICY_RULES.filter(
      (rule) => !onDisk.includes(`## ${rule.policyRef.replace('REFUND_POLICY.md ', '')}`),
    ).map((rule) => `${rule.id} -> ${rule.policyRef}`);
    expect(missing).toEqual([]);
  });

  it('documents every rule in the appendix', () => {
    const onDisk = readFileSync(DOC_PATH, 'utf8');
    for (const rule of POLICY_RULES) {
      expect(onDisk).toContain(`\`${rule.id}\``);
    }
  });
});
