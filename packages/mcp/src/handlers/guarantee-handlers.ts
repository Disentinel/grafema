/**
 * MCP Guarantee Handlers
 */

import { getOrCreateBackend, getGuaranteeManager, getGuaranteeAPI } from '../state.js';
import {
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  CreateGuaranteeArgs,
  CheckGuaranteesArgs,
  DeleteGuaranteeArgs,
} from '../types.js';
import { isGuaranteeType } from '@grafema/core';

// === GUARANTEE HANDLERS ===

/**
 * Create a new guarantee (Datalog-based or contract-based)
 */
export async function handleCreateGuarantee(args: CreateGuaranteeArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { name, rule, type, priority, status, owner, schema, condition, description, governs, severity } = args;

  try {
    // Determine if this is a contract-based guarantee
    if (type && isGuaranteeType(type)) {
      // Contract-based guarantee
      const api = getGuaranteeAPI();
      if (!api) {
        return errorResult('GuaranteeAPI not initialized');
      }

      const guarantee = await api.createGuarantee({
        type,
        name,
        priority,
        status,
        owner,
        schema,
        condition,
        description,
        governs,
      });

      return textResult(
        `✅ Created contract-based guarantee: ${guarantee.id}\n` +
        `Type: ${guarantee.type}\n` +
        `Priority: ${guarantee.priority}\n` +
        `Status: ${guarantee.status}` +
        (guarantee.description ? `\nDescription: ${guarantee.description}` : '')
      );
    } else {
      // Datalog-based guarantee
      if (!rule) {
        return errorResult('Datalog-based guarantee requires "rule" field');
      }

      const manager = getGuaranteeManager();
      if (!manager) {
        return errorResult('GuaranteeManager not initialized');
      }

      const guarantee = await manager.create({
        id: name,
        name,
        rule,
        severity: severity || 'warning',
        governs: governs || ['**/*.js'],
      });

      return textResult(
        `✅ Created Datalog-based guarantee: ${guarantee.id}\n` +
        `Rule: ${guarantee.rule}\n` +
        `Severity: ${guarantee.severity}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to create guarantee: ${message}`);
  }
}

/**
 * List all guarantees (both Datalog-based and contract-based)
 */
export async function handleListGuarantees(): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const results: string[] = [];

  try {
    // List Datalog-based guarantees
    const manager = getGuaranteeManager();
    if (manager) {
      const datalogGuarantees = await manager.list();
      if (datalogGuarantees.length > 0) {
        results.push('## Datalog-based Guarantees\n');
        for (const g of datalogGuarantees) {
          results.push(`- **${g.id}** (${g.severity})`);
          results.push(`  Rule: ${g.rule.substring(0, 80)}${g.rule.length > 80 ? '...' : ''}`);
        }
      }
    }

    // List contract-based guarantees
    const api = getGuaranteeAPI();
    if (api) {
      const contractGuarantees = await api.findGuarantees();
      if (contractGuarantees.length > 0) {
        if (results.length > 0) results.push('\n');
        results.push('## Contract-based Guarantees\n');
        for (const g of contractGuarantees) {
          results.push(`- **${g.id}** [${g.priority}] (${g.status})`);
          if (g.description) results.push(`  ${g.description}`);
        }
      }
    }

    if (results.length === 0) {
      return textResult('No guarantees defined yet.');
    }

    return textResult(results.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to list guarantees: ${message}`);
  }
}

/**
 * Check guarantees (both Datalog-based and contract-based)
 */
export async function handleCheckGuarantees(args: CheckGuaranteesArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { names } = args;
  const results: string[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  try {
    const manager = getGuaranteeManager();
    const api = getGuaranteeAPI();

    if (names && names.length > 0) {
      // Check specific guarantees
      for (const name of names) {
        // Try Datalog-based first
        if (manager) {
          try {
            const result = await manager.check(name);
            if (result.passed) {
              totalPassed++;
              results.push(`✅ ${result.guaranteeId}: PASSED`);
            } else {
              totalFailed++;
              results.push(`❌ ${result.guaranteeId}: FAILED (${result.violationCount} violations)`);
              for (const v of result.violations.slice(0, 5)) {
                results.push(`   - ${v.file}:${v.line} (${v.type})`);
              }
              if (result.violationCount > 5) {
                results.push(`   ... and ${result.violationCount - 5} more`);
              }
            }
            continue;
          } catch {
            // Not a Datalog guarantee, try contract-based
          }
        }

        // Try contract-based
        if (api) {
          try {
            const result = await api.checkGuarantee(name);
            if (result.passed) {
              totalPassed++;
              results.push(`✅ ${result.id}: PASSED`);
            } else {
              totalFailed++;
              results.push(`❌ ${result.id}: FAILED`);
              for (const err of result.errors.slice(0, 5)) {
                results.push(`   - ${err}`);
              }
            }
          } catch {
            results.push(`⚠️ ${name}: Not found`);
          }
        }
      }
    } else {
      // Check all guarantees
      if (manager) {
        const datalogResult = await manager.checkAll();
        totalPassed += datalogResult.passed;
        totalFailed += datalogResult.failed;

        if (datalogResult.total > 0) {
          results.push('## Datalog Guarantees\n');
          for (const r of datalogResult.results) {
            if (r.passed) {
              results.push(`✅ ${r.guaranteeId}: PASSED`);
            } else {
              results.push(`❌ ${r.guaranteeId}: FAILED (${r.violationCount} violations)`);
            }
          }
        }
      }

      if (api) {
        const contractResult = await api.checkAllGuarantees();
        totalPassed += contractResult.passed;
        totalFailed += contractResult.failed;

        if (contractResult.total > 0) {
          if (results.length > 0) results.push('\n');
          results.push('## Contract Guarantees\n');
          for (const r of contractResult.results) {
            if (r.passed) {
              results.push(`✅ ${r.id}: PASSED`);
            } else {
              results.push(`❌ ${r.id}: FAILED`);
            }
          }
        }
      }
    }

    if (results.length === 0) {
      return textResult('No guarantees to check.');
    }

    const summary = `\n---\nTotal: ${totalPassed + totalFailed} | ✅ Passed: ${totalPassed} | ❌ Failed: ${totalFailed}`;
    return textResult(results.join('\n') + summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to check guarantees: ${message}`);
  }
}

/**
 * Delete a guarantee
 */
export async function handleDeleteGuarantee(args: DeleteGuaranteeArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { name } = args;

  try {
    // Try Datalog-based first
    const manager = getGuaranteeManager();
    if (manager) {
      try {
        await manager.delete(name);
        return textResult(`✅ Deleted Datalog guarantee: ${name}`);
      } catch {
        // Not found in Datalog, try contract-based
      }
    }

    // Try contract-based
    const api = getGuaranteeAPI();
    if (api) {
      const deleted = await api.deleteGuarantee(name);
      if (deleted) {
        return textResult(`✅ Deleted contract guarantee: ${name}`);
      }
    }

    return errorResult(`Guarantee not found: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to delete guarantee: ${message}`);
  }
}
