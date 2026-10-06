import type { Principal } from '../auth/tokens.js';

export function requirePrincipal(principal: Principal | undefined, message: string): Principal {
  if (principal === undefined) {
    throw new Error(message);
  }
  return principal;
}
