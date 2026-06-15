/**
 * Log-level resolution shared by the `analyze` and `resolve` CLI commands.
 *
 * Both commands spawn the native grafema-orchestrator and must translate the
 * user's verbosity flags into two things: a TypeScript-side {@link LogLevel}
 * (for the CLI's own logger / progress UI) and a `RUST_LOG` directive for the
 * spawned orchestrator process. Keeping the mapping in one place avoids the
 * drift that previously let the CLI default to a quiet progress UI while the
 * orchestrator was told `RUST_LOG=info` and spammed INFO on every run (QA-8).
 */

import type { LogLevel } from '@grafema/util';

/** CLI verbosity flags accepted by the `analyze` / `resolve` commands. */
export interface LogLevelOptions {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  logLevel?: string;
}

/**
 * Resolve the CLI-side {@link LogLevel} from verbosity flags.
 *
 * Priority: `--log-level` > `--quiet` > `--verbose` > default (`'silent'`).
 * The default is silent so the interactive progress UI stays clean; `--verbose`
 * surfaces INFO logs instead of the progress UI.
 *
 * @param options - parsed command options.
 * @returns the resolved {@link LogLevel}.
 */
export function getLogLevel(options: LogLevelOptions): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';  // --verbose shows logs instead of progress UI
  return 'silent';  // Default: silent logs, clean progress UI
}

/**
 * Map a resolved {@link LogLevel} to the `RUST_LOG` value understood by the
 * spawned grafema-orchestrator (`tracing_subscriber::fmt::init()` reads
 * `RUST_LOG`; with no value it defaults to INFO).
 *
 * `'silent'` deliberately maps to `'warn'` rather than `'error'`/`'off'`:
 * genuine warnings — failed parses, skipped oversized files, resolver
 * fallbacks — must still surface so an incomplete analysis is never hidden.
 * Only routine INFO progress noise is suppressed.
 *
 * @param level - the resolved CLI log level from {@link getLogLevel}.
 * @returns the `RUST_LOG` directive string for the orchestrator process.
 */
export function logLevelToRustLog(level: LogLevel): string {
  switch (level) {
    case 'debug':    return 'debug';
    case 'info':     return 'info';
    case 'warnings': return 'warn';
    case 'errors':   return 'error';
    case 'silent':   return 'warn';
    default:         return 'warn';
  }
}

/**
 * Resolve the `RUST_LOG` env value for the spawned orchestrator from CLI options.
 *
 * Mirrors {@link getLogLevel}'s precedence so native log verbosity matches the
 * documented CLI intent: quiet by default (clean output — the CLI still prints
 * its own completion summary), `--verbose` to stream INFO logs instead of the
 * progress UI, `--debug` for DEBUG diagnostics. Previously the default was
 * `'info'`, which spammed `INFO grafema_orchestrator: Starting analysis …` on
 * every run and read like an error to first-time users (QA-8); it also left
 * `--verbose` indistinguishable from the default.
 *
 * @param options - parsed command options.
 * @returns the `RUST_LOG` directive string (e.g. `'warn'`, `'info'`, `'debug'`).
 */
export function getRustLog(options: LogLevelOptions): string {
  if (options.debug) return 'debug';
  return logLevelToRustLog(getLogLevel(options));
}
