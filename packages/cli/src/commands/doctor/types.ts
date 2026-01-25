/**
 * Type definitions for `grafema doctor` command - REG-214
 */

/**
 * Status of a single diagnostic check
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * Result of a single diagnostic check
 */
export interface DoctorCheckResult {
  name: string;           // e.g., 'config', 'server', 'database'
  status: CheckStatus;
  message: string;        // Human-readable message
  recommendation?: string; // Actionable next step if not pass
  details?: Record<string, unknown>; // Additional data (counts, versions, etc.)
}

/**
 * Options for the doctor command
 */
export interface DoctorOptions {
  project: string;        // Project path (default: ".")
  json?: boolean;         // Output as JSON
  quiet?: boolean;        // Only show failures
  verbose?: boolean;      // Show detailed diagnostics
}

/**
 * Overall doctor report (for JSON output)
 */
export interface DoctorReport {
  status: 'healthy' | 'warning' | 'error';
  timestamp: string;      // ISO timestamp
  project: string;        // Absolute project path
  checks: DoctorCheckResult[];
  recommendations: string[];
  versions: {
    cli: string;
    core: string;
    rfdb?: string;
  };
}
