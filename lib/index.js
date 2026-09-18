/**
 * Host half of `dsh-usage-stats`.
 *
 * Responsibilities, in full:
 *   · mount one read-only JSON route (`/plugins/dsh-usage-stats/usage`) that
 *     reports provider-token usage folded out of this harness's session logs;
 *   · keep the grow-only usage ledger current with a background sweep, so a
 *     session that is later deleted keeps its usage.
 *
 * It holds no credential, contacts no provider, changes no model routing, and
 * writes exactly one file — the ledger — inside `$DSH_HOME`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { USAGE_ROUTE, createUsageService, usageHandler } from './usage/host.js';

export const name = 'dsh-usage-stats';
export const inject = [];

/** The harness home: `$DSH_HOME` when set, else `~/.dsh` (DSH's own order). */
export function dshHome() {
  const configured = process.env['DSH_HOME'];
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  return join(homedir(), '.dsh');
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const home = dshHome();
    const service = createUsageService({
      dshHome: home,
      sessionsRoot: join(home, 'sessions'),
      logger: webCtx.logger ?? ctx.logger,
    });

    webCtx.effect(() => {
      /* Exact, not prefix: this route owns exactly one pathname, and a prefix
         registration would additionally claim every sub-path beneath it. The
         web server checks its exact table before its prefix table, so this also
         takes precedence over the `/plugins` prefix the client-module carrier
         owns. */
      const disposeRoute = webCtx.webServer.register({
        kind: 'exact',
        path: USAGE_ROUTE,
        handler: usageHandler(service),
      });
      const stopSweep = service.startSweep();
      return () => {
        disposeRoute();
        stopSweep();
      };
    }, 'dsh-usage-stats: token-usage route and usage-ledger sweep');
  });
}
