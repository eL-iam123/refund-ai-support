/**
 * Regenerates REFUND_POLICY.md from the enforcing rules.
 *
 * Run with `pnpm policy:doc`. The doc is committed to the repository on
 * purpose: the API returns a `policyRef` pointing into it, so the file has to
 * exist wherever the API is deployed.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../lib/logger.js';
import { renderPolicyDocument } from './policyDocument.js';

/**
 * Deliberately does not call `readEnv()`. Rendering the policy needs no
 * configuration and no secrets, so it must work in CI and on a clean checkout;
 * coupling it to a provider key would make the docs unbuildable off-machine.
 */
function main(): void {
  const log = createLogger('info');
  const target = fileURLToPath(new URL('../../../../REFUND_POLICY.md', import.meta.url));
  writeFileSync(target, renderPolicyDocument(), 'utf8');
  log.info({ target }, 'policy.doc.written');
}

main();
