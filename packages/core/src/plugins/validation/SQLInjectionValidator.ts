/**
 * SQLInjectionValidator - детектирует SQL injection уязвимости
 *
 * Security инвариант: SQL запросы не должны содержать недетерминированные
 * значения (user input) без параметризации.
 *
 * Детектирует:
 * - Template literal с переменными от параметров: `SELECT * FROM users WHERE id = ${userId}`
 * - String concatenation с user input: "SELECT * FROM users WHERE id = " + userId
 *
 * Безопасные паттерны (НЕ flagged):
 * - Параметризованные запросы: db.query('SELECT * FROM users WHERE id = ?', [userId])
 * - Только литералы: const query = 'SELECT * FROM users'
 * - Литералы в template: const role = 'admin'; `SELECT * FROM users WHERE role = '${role}'`
 *
 * ПРАВИЛА:
 * 1. Найти CALL с method = query/execute/run/all/get
 * 2. Проверить первый аргумент - если содержит nondeterministic value → violation
 * 3. Использовать ValueDomainAnalyzer для трассировки значений
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, NodeRecord } from '@grafema/types';
import type { EdgeRecord as TypesEdgeRecord } from '@grafema/types';
import { ValueDomainAnalyzer } from '../enrichment/ValueDomainAnalyzer.js';

// Type expected by ValueDomainAnalyzer
interface ValueAnalyzerGraph {
  queryNodes(filter: { nodeType: string }): AsyncIterable<NodeRecord>;
  getNode(id: string): Promise<NodeRecord | null>;
  getOutgoingEdges(nodeId: string): Promise<TypesEdgeRecord[]>;
  getIncomingEdges(nodeId: string): Promise<TypesEdgeRecord[]>;
  addEdge(edge: { src: string; dst: string; type: string; metadata?: Record<string, unknown> }): Promise<void> | void;
}

// SQL query method names to detect
const SQL_METHODS = ['query', 'execute', 'exec', 'run', 'all', 'get', 'prepare', 'raw'];

/**
 * SQL injection issue
 */
interface SQLInjectionIssue {
  type: string;
  severity: string;
  message: string;
  nodeId: string;
  file?: string;
  line?: number;
  reason: string;
  nondeterministicSources: string[];
}

/**
 * Analysis result
 */
interface AnalysisResult {
  isVulnerable: boolean;
  reason: string | null;
  sources: string[];
}

/**
 * Edge record
 */
interface EdgeRecord {
  edgeType?: string;
  edge_type?: string;
  dst?: string;
  target_id?: string;
  argIndex?: number;
  index?: number;
  [key: string]: unknown;
}

/**
 * Extended node with query properties
 */
interface CallNode extends BaseNodeRecord {
  method?: string;
  queryArgName?: string;
  nodeType?: string;
  attrs?: { name?: string };
}

/**
 * Datalog violation result
 */
interface DatalogViolation {
  bindings: Array<{ name: string; value: string }>;
}

export class SQLInjectionValidator extends Plugin {
  private valueAnalyzer: ValueDomainAnalyzer;

  constructor() {
    super();
    this.valueAnalyzer = new ValueDomainAnalyzer();
  }

  get metadata(): PluginMetadata {
    return {
      name: 'SQLInjectionValidator',
      phase: 'VALIDATION',
      priority: 90, // After ValueDomainAnalyzer (65)
      creates: {
        nodes: ['issue:security'],
        edges: ['AFFECTS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting SQL injection vulnerability check');

    const issues: SQLInjectionIssue[] = [];
    let issueNodeCount = 0;
    let affectsEdgeCount = 0;

    // 1. Find all CALL nodes that look like SQL queries
    const sqlCalls: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = node as CallNode;
      const method = callNode.method || callNode.name;
      if (method && SQL_METHODS.includes(method as string)) {
        sqlCalls.push(callNode);
      }
    }

    logger.debug('SQL calls collected', { count: sqlCalls.length });

    // 2. For each SQL call, analyze the query argument
    for (const call of sqlCalls) {
      const result = await this.analyzeQueryCall(call, graph);
      if (result.isVulnerable) {
        const issue: SQLInjectionIssue = {
          type: 'SQL_INJECTION',
          severity: 'ERROR',
          message: `Potential SQL injection at ${call.file}:${call.line || '?'} - ${result.reason}`,
          nodeId: call.id,
          file: call.file,
          line: call.line as number | undefined,
          reason: result.reason!,
          nondeterministicSources: result.sources
        };
        issues.push(issue);

        // Persist issue to graph if reportIssue is available
        if (context.reportIssue) {
          await context.reportIssue({
            category: 'security',
            severity: 'error',
            message: issue.message,
            file: call.file || '',
            line: call.line || 0,
            column: call.column || 0,
            targetNodeId: call.id,
            context: {
              type: 'SQL_INJECTION',
              reason: result.reason,
              nondeterministicSources: result.sources
            }
          });
          issueNodeCount++;
          affectsEdgeCount++;
        }
      }
    }

    // 3. Also check via graph pattern - CALL nodes that have ARGUMENT -> PARAMETER paths
    const patternViolations = await this.checkViaGraphPattern(graph, logger, sqlCalls);
    for (const violation of patternViolations) {
      // Avoid duplicates
      if (!issues.find(i => i.nodeId === violation.nodeId)) {
        issues.push(violation);

        // Persist issue to graph if reportIssue is available
        if (context.reportIssue) {
          await context.reportIssue({
            category: 'security',
            severity: 'error',
            message: violation.message,
            file: violation.file || '',
            line: violation.line || 0,
            targetNodeId: violation.nodeId,
            context: {
              type: 'SQL_INJECTION',
              reason: violation.reason,
              nondeterministicSources: violation.nondeterministicSources
            }
          });
          issueNodeCount++;
          affectsEdgeCount++;
        }
      }
    }

    const summary = {
      sqlCallsChecked: sqlCalls.length,
      vulnerabilitiesFound: issues.length,
      issueNodesCreated: issueNodeCount,
      affectsEdgesCreated: affectsEdgeCount
    };

    logger.info('Validation complete', summary);

    if (issues.length > 0) {
      logger.warn('SQL injection vulnerabilities found', { count: issues.length });
      for (const issue of issues) {
        logger.warn(issue.message);
      }
    } else {
      logger.info('No SQL injection vulnerabilities detected');
    }

    return createSuccessResult(
      { nodes: issueNodeCount, edges: affectsEdgeCount },
      { summary, issues }
    );
  }

  /**
   * Analyze a SQL query call for injection vulnerabilities
   */
  private async analyzeQueryCall(call: CallNode, graph: PluginContext['graph']): Promise<AnalysisResult> {
    const result: AnalysisResult = {
      isVulnerable: false,
      reason: null,
      sources: []
    };

    // Get the query argument - usually first argument
    // We need to check if it has nondeterministic content

    // Check if this call has PASSES_ARGUMENT edges
    const outgoing = await graph.getOutgoingEdges(call.id) as unknown as EdgeRecord[];
    const argEdges = outgoing.filter(e => e.type === 'PASSES_ARGUMENT');

    if (argEdges.length === 0) {
      // No tracked arguments - check via queryArgName attribute if available
      if (call.queryArgName) {
        const valueSet = await this.valueAnalyzer.getValueSet(call.queryArgName, call.file!, graph as unknown as ValueAnalyzerGraph);
        if (valueSet.hasUnknown) {
          result.isVulnerable = true;
          result.reason = `Query argument "${call.queryArgName}" contains user input`;
          result.sources = ['unknown'];
        }
      }
      return result;
    }

    // Check each argument
    for (const edge of argEdges) {
      const argId = edge.dst || edge.target_id;
      const argNode = await graph.getNode(argId!) as CallNode | null;
      if (!argNode) continue;

      const argIndex = edge.argIndex || edge.index;
      if (argIndex !== 0 && argIndex !== undefined) continue; // Only check first argument

      // Check argument type
      const argType = argNode.nodeType || argNode.type;

      if (argType === 'LITERAL') {
        // Pure literal - safe
        continue;
      }

      if (argType === 'VARIABLE' || argType === 'CONSTANT') {
        // Trace value domain
        const varName = argNode.name || argNode.attrs?.name;
        if (varName) {
          const valueSet = await this.valueAnalyzer.getValueSet(varName as string, call.file!, graph as unknown as ValueAnalyzerGraph);
          if (valueSet.hasUnknown) {
            result.isVulnerable = true;
            result.reason = `Query variable "${varName}" may contain user input`;
            result.sources.push(varName as string);
          }
        }
      }

      if (argType === 'PARAMETER') {
        // Direct parameter in query - definitely vulnerable
        result.isVulnerable = true;
        result.reason = 'Query contains direct function parameter';
        result.sources.push((argNode.name as string) || 'parameter');
      }

      if (argType === 'EXPRESSION') {
        // Template literal or concatenation - check for nondeterministic values
        const { hasUnknown, sources } = await this.checkExpressionForNondeterminism(argNode, graph);
        if (hasUnknown) {
          result.isVulnerable = true;
          result.reason = 'Query expression contains nondeterministic values';
          result.sources.push(...sources);
        }
      }
    }

    return result;
  }

  /**
   * Check if an expression contains nondeterministic values
   */
  private async checkExpressionForNondeterminism(
    exprNode: CallNode,
    graph: PluginContext['graph']
  ): Promise<{ hasUnknown: boolean; sources: string[] }> {
    const result = { hasUnknown: false, sources: [] as string[] };

    // Check DERIVES_FROM edges
    const outgoing = await graph.getOutgoingEdges(exprNode.id) as unknown as EdgeRecord[];
    const derivesFromEdges = outgoing.filter(e =>
      e.type === 'DERIVES_FROM' || e.type === 'ASSIGNED_FROM'
    );

    for (const edge of derivesFromEdges) {
      const sourceId = edge.dst || edge.target_id;
      const sourceNode = await graph.getNode(sourceId!) as CallNode | null;
      if (!sourceNode) continue;

      const sourceType = sourceNode.nodeType || sourceNode.type;

      if (sourceType === 'PARAMETER') {
        result.hasUnknown = true;
        result.sources.push((sourceNode.name as string) || 'parameter');
      } else if (sourceType === 'VARIABLE' || sourceType === 'CONSTANT') {
        const varName = sourceNode.name || sourceNode.attrs?.name;
        if (varName) {
          const valueSet = await this.valueAnalyzer.getValueSet(varName as string, exprNode.file!, graph);
          if (valueSet.hasUnknown) {
            result.hasUnknown = true;
            result.sources.push(varName as string);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check via Datalog graph pattern for SQL injection
   * Pattern: CALL -[PASSES_ARGUMENT]-> VARIABLE -[ASSIGNED_FROM*]-> PARAMETER
   */
  private async checkViaGraphPattern(
    graph: PluginContext['graph'],
    logger: ReturnType<typeof this.log>,
    excludeCalls: CallNode[] = []
  ): Promise<SQLInjectionIssue[]> {
    const issues: SQLInjectionIssue[] = [];
    const excludeIds = new Set(excludeCalls.map(c => c.id));

    // Find CALL nodes that have argument tracing to PARAMETER
    try {
      // Check if graph supports checkGuarantee
      if (!graph.checkGuarantee) {
        logger.debug('Graph does not support checkGuarantee, skipping pattern-based check');
        return issues;
      }

      // Check guarantee for SQL method calls with parameter-derived arguments
      const violations = await graph.checkGuarantee(`
        violation(X) :-
          node(X, "CALL"),
          attr(X, "method", M),
          edge(X, Arg, "PASSES_ARGUMENT"),
          edge(Arg, P, "ASSIGNED_FROM"),
          node(P, "PARAMETER").
      `) as DatalogViolation[];

      for (const v of violations) {
        const nodeId = v.bindings.find(b => b.name === 'X')?.value;
        if (nodeId && !excludeIds.has(nodeId)) {
          const node = await graph.getNode(nodeId) as CallNode | null;
          if (node) {
            const method = node.method || node.name;
            if (SQL_METHODS.includes(method as string)) {
              issues.push({
                type: 'SQL_INJECTION',
                severity: 'ERROR',
                message: `SQL injection via parameter flow at ${node.file}:${node.line || '?'}`,
                nodeId,
                file: node.file,
                line: node.line as number | undefined,
                reason: 'Parameter value flows into SQL query',
                nondeterministicSources: ['parameter']
              });
            }
          }
        }
      }
    } catch (err) {
      // Datalog query might fail if backend doesn't support it
      logger.debug('Datalog check skipped', { error: (err as Error).message });
    }

    return issues;
  }
}

export default SQLInjectionValidator;
