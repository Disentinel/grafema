/**
 * GuaranteeManager - управление гарантиями/инвариантами кода
 *
 * GUARANTEE ноды хранят Datalog правила, которые код должен соблюдать.
 * GOVERNS edges связывают гарантии с модулями, к которым они применяются.
 *
 * Workflow:
 * 1. Создать гарантию (create) → GUARANTEE нода + GOVERNS edges
 * 2. Проверить (check) → выполнить Datalog rule, найти нарушения
 * 3. Экспортировать (export) → сохранить в YAML для version control
 * 4. Импортировать (import) → загрузить из YAML в граф
 * 5. Drift detection → сравнить граф с файлом
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, isAbsolute, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { minimatch } from 'minimatch';

/**
 * Severity level for guarantees
 */
export type GuaranteeSeverity = 'error' | 'warning' | 'info';

/**
 * Guarantee definition
 */
export interface GuaranteeDefinition {
  id: string;
  name?: string;
  rule: string;
  severity?: GuaranteeSeverity;
  governs?: string[];
}

/**
 * Guarantee node structure
 */
export interface GuaranteeNode {
  id: string;
  type: 'GUARANTEE';
  name: string;
  rule: string;
  severity: GuaranteeSeverity;
  governs: string[];
  version: 'meta';
  createdAt: number;
  governedModules?: string[];
}

/**
 * Edge structure
 */
export interface GraphEdge {
  type: string;
  src: string;
  dst: string;
}

/**
 * Module node
 */
export interface ModuleNode {
  id: string;
  type: string;
  file?: string;
}

/**
 * Violation binding
 */
export interface ViolationBinding {
  name: string;
  value: string;
}

/**
 * Violation result from Datalog
 */
export interface ViolationResult {
  bindings?: ViolationBinding[];
}

/**
 * Enriched violation info
 */
export interface EnrichedViolation {
  nodeId: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
}

/**
 * Check result for a single guarantee
 */
export interface GuaranteeCheckResult {
  guaranteeId: string;
  name: string;
  severity: GuaranteeSeverity;
  passed: boolean;
  violationCount: number;
  violations: EnrichedViolation[];
  error: string | null;
  checkDurationMs: number;
}

/**
 * Check all result
 */
export interface CheckAllResult {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  results: GuaranteeCheckResult[];
}

/**
 * Import options
 */
export interface ImportOptions {
  clearExisting?: boolean;
}

/**
 * Import result
 */
export interface ImportResult {
  imported: number;
  skipped: number;
  importedIds: string[];
  skippedIds: string[];
}

/**
 * Modified guarantee in drift
 */
export interface ModifiedGuarantee {
  id: string;
  changes: string[];
}

/**
 * Drift summary
 */
export interface DriftSummary {
  onlyInGraph: number;
  onlyInFile: number;
  modified: number;
  unchanged: number;
}

/**
 * Drift result
 */
export interface DriftResult {
  hasDrift: boolean;
  summary: DriftSummary;
  onlyInGraph: string[];
  onlyInFile: string[];
  modified: ModifiedGuarantee[];
  unchanged: string[];
}

/**
 * Export data format
 */
export interface ExportData {
  version: number;
  exportedAt: string;
  guarantees: Array<{
    id: string;
    name: string;
    rule: string;
    severity: GuaranteeSeverity;
    governs: string[];
  }>;
}

/**
 * Graph interface for GuaranteeManager
 */
export interface GuaranteeGraph {
  addNode(node: GuaranteeNode): Promise<void>;
  getNode(id: string): Promise<GuaranteeNode | ModuleNode | null>;
  deleteNode(id: string): Promise<void>;
  queryNodes(filter: { type: string }): AsyncIterable<GuaranteeNode | ModuleNode>;
  addEdge(edge: GraphEdge): Promise<void>;
  deleteEdge(src: string, dst: string, type: string): Promise<void>;
  getOutgoingEdges(nodeId: string, types: string[]): Promise<GraphEdge[]>;
  getIncomingEdges(nodeId: string, types: string[]): Promise<GraphEdge[]>;
  checkGuarantee(rule: string): Promise<ViolationResult[]>;
}

export class GuaranteeManager {
  private graph: GuaranteeGraph;
  private projectPath: string;
  private guaranteesFile: string;

  constructor(graph: GuaranteeGraph, projectPath: string) {
    this.graph = graph;
    this.projectPath = projectPath;
    this.guaranteesFile = join(projectPath, '.grafema', 'guarantees.yaml');
  }

  /**
   * Создать новую гарантию
   */
  async create(guarantee: GuaranteeDefinition): Promise<GuaranteeNode> {
    const { id, name, rule, severity = 'warning', governs = ['**/*.js'] } = guarantee;

    if (!id || !rule) {
      throw new Error('Guarantee must have id and rule');
    }

    // Создаём GUARANTEE ноду
    const guaranteeNode: GuaranteeNode = {
      id: `GUARANTEE:${id}`,
      type: 'GUARANTEE',
      name: name || id,
      rule: rule,
      severity: severity,
      governs: governs, // Сохраняем patterns для export
      version: 'meta', // Гарантии в отдельном слое
      createdAt: Date.now()
    };

    await this.graph.addNode(guaranteeNode);

    // Создаём GOVERNS edges к matching модулям
    await this._createGovernsEdges(guaranteeNode.id, governs);

    return guaranteeNode;
  }

  /**
   * Получить все гарантии из графа
   */
  async list(): Promise<GuaranteeNode[]> {
    const guarantees: GuaranteeNode[] = [];
    for await (const node of this.graph.queryNodes({ type: 'GUARANTEE' })) {
      const guaranteeNode = node as GuaranteeNode;
      // Получаем GOVERNS edges для этой гарантии
      const governsEdges = await this.graph.getOutgoingEdges(guaranteeNode.id, ['GOVERNS']);
      const governedModules: string[] = [];
      for (const edge of governsEdges) {
        const targetNode = await this.graph.getNode(edge.dst);
        if (targetNode) {
          governedModules.push((targetNode as ModuleNode).file || targetNode.id);
        }
      }

      guarantees.push({
        ...guaranteeNode,
        governedModules
      });
    }
    return guarantees;
  }

  /**
   * Проверить гарантию
   */
  async check(guaranteeId: string): Promise<GuaranteeCheckResult> {
    const fullId = guaranteeId.startsWith('GUARANTEE:') ? guaranteeId : `GUARANTEE:${guaranteeId}`;
    const node = (await this.graph.getNode(fullId)) as GuaranteeNode | null;

    if (!node) {
      throw new Error(`Guarantee not found: ${guaranteeId}`);
    }

    const startTime = Date.now();
    let violations: ViolationResult[] = [];
    let error: string | null = null;

    try {
      violations = await this.graph.checkGuarantee(node.rule);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    // Обогащаем violations информацией о нодах
    const enrichedViolations: EnrichedViolation[] = [];
    for (const v of violations) {
      const nodeId = v.bindings?.find(b => b.name === 'X')?.value;
      if (nodeId) {
        const violatingNode = await this.graph.getNode(nodeId);
        if (violatingNode) {
          enrichedViolations.push({
            nodeId,
            type: violatingNode.type,
            name: (violatingNode as GuaranteeNode).name,
            file: (violatingNode as ModuleNode).file,
            line: (violatingNode as { line?: number }).line
          });
        }
      }
    }

    return {
      guaranteeId: guaranteeId,
      name: node.name,
      severity: node.severity,
      passed: violations.length === 0 && !error,
      violationCount: violations.length,
      violations: enrichedViolations,
      error,
      checkDurationMs: Date.now() - startTime
    };
  }

  /**
   * Проверить все гарантии
   */
  async checkAll(): Promise<CheckAllResult> {
    const guarantees = await this.list();
    const results: GuaranteeCheckResult[] = [];
    let passedCount = 0;
    let failedCount = 0;
    let errorCount = 0;

    for (const g of guarantees) {
      const result = await this.check(g.id);
      results.push(result);

      if (result.error) {
        errorCount++;
      } else if (result.passed) {
        passedCount++;
      } else {
        failedCount++;
      }
    }

    return {
      total: guarantees.length,
      passed: passedCount,
      failed: failedCount,
      errors: errorCount,
      results
    };
  }

  /**
   * Удалить гарантию
   */
  async delete(guaranteeId: string): Promise<void> {
    const fullId = guaranteeId.startsWith('GUARANTEE:') ? guaranteeId : `GUARANTEE:${guaranteeId}`;

    // Удаляем GOVERNS edges
    const edges = await this.graph.getOutgoingEdges(fullId, ['GOVERNS']);
    for (const edge of edges) {
      await this.graph.deleteEdge(edge.src, edge.dst, 'GOVERNS');
    }

    // Удаляем ноду
    await this.graph.deleteNode(fullId);
  }

  /**
   * Экспортировать гарантии в YAML файл
   */
  async export(filePath: string = this.guaranteesFile): Promise<string> {
    const guarantees = await this.list();

    const exportData: ExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      guarantees: guarantees.map(g => ({
        id: g.id.replace('GUARANTEE:', ''),
        name: g.name,
        rule: g.rule,
        severity: g.severity,
        governs: g.governs || ['**/*.js']
      }))
    };

    const yaml = stringifyYaml(exportData, { lineWidth: 0 });
    writeFileSync(filePath, yaml, 'utf-8');

    return filePath;
  }

  /**
   * Импортировать гарантии из YAML файла
   */
  async import(filePath: string = this.guaranteesFile, options: ImportOptions = {}): Promise<ImportResult> {
    const { clearExisting = false } = options;

    if (!existsSync(filePath)) {
      throw new Error(`Guarantees file not found: ${filePath}`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const data = parseYaml(content) as ExportData;

    if (!data.guarantees || !Array.isArray(data.guarantees)) {
      throw new Error('Invalid guarantees file format');
    }

    // Удаляем существующие если нужно
    if (clearExisting) {
      const existing = await this.list();
      for (const g of existing) {
        await this.delete(g.id);
      }
    }

    // Импортируем
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const g of data.guarantees) {
      const fullId = `GUARANTEE:${g.id}`;
      const existing = await this.graph.getNode(fullId);

      if (existing && !clearExisting) {
        skipped.push(g.id);
        continue;
      }

      await this.create(g);
      imported.push(g.id);
    }

    return {
      imported: imported.length,
      skipped: skipped.length,
      importedIds: imported,
      skippedIds: skipped
    };
  }

  /**
   * Показать drift между графом и файлом
   */
  async drift(filePath: string = this.guaranteesFile): Promise<DriftResult> {
    const graphGuarantees = await this.list();
    const graphMap = new Map<string, GuaranteeNode>(
      graphGuarantees.map(g => [g.id.replace('GUARANTEE:', ''), g])
    );

    let fileGuarantees: Array<{ id: string; name: string; rule: string; severity: GuaranteeSeverity; governs: string[] }> = [];
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const data = parseYaml(content) as ExportData;
      fileGuarantees = data.guarantees || [];
    }
    const fileMap = new Map(fileGuarantees.map(g => [g.id, g]));

    const onlyInGraph: string[] = [];
    const onlyInFile: string[] = [];
    const modified: ModifiedGuarantee[] = [];
    const unchanged: string[] = [];

    // Проверяем гарантии в графе
    for (const [id, graphG] of graphMap) {
      const fileG = fileMap.get(id);
      if (!fileG) {
        onlyInGraph.push(id);
      } else if (this._hasChanges(graphG, fileG)) {
        modified.push({
          id,
          changes: this._describeChanges(graphG, fileG)
        });
      } else {
        unchanged.push(id);
      }
    }

    // Проверяем гарантии только в файле
    for (const [id] of fileMap) {
      if (!graphMap.has(id)) {
        onlyInFile.push(id);
      }
    }

    return {
      hasDrift: onlyInGraph.length > 0 || onlyInFile.length > 0 || modified.length > 0,
      summary: {
        onlyInGraph: onlyInGraph.length,
        onlyInFile: onlyInFile.length,
        modified: modified.length,
        unchanged: unchanged.length
      },
      onlyInGraph,
      onlyInFile,
      modified,
      unchanged
    };
  }

  /**
   * Найти гарантии затронутые изменением ноды
   */
  async findAffectedGuarantees(nodeId: string): Promise<string[]> {
    const node = await this.graph.getNode(nodeId);
    if (!node) return [];

    // Поднимаемся до MODULE
    let moduleId: string | null = null;
    if (node.type === 'MODULE') {
      moduleId = node.id;
    } else if ((node as ModuleNode).file) {
      // Ищем MODULE по file
      for await (const m of this.graph.queryNodes({ type: 'MODULE' })) {
        if ((m as ModuleNode).file === (node as ModuleNode).file) {
          moduleId = m.id;
          break;
        }
      }
    }

    if (!moduleId) return [];

    // Находим GOVERNS edges к этому модулю
    const incomingEdges = await this.graph.getIncomingEdges(moduleId, ['GOVERNS']);
    return incomingEdges.map(e => e.src);
  }

  // ============ Private methods ============

  /**
   * Создать GOVERNS edges к модулям по glob patterns
   */
  private async _createGovernsEdges(guaranteeId: string, patterns: string[]): Promise<void> {
    // Получаем все MODULE ноды
    const modules: ModuleNode[] = [];
    for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
      modules.push(node as ModuleNode);
    }

    // Матчим patterns
    for (const module of modules) {
      const relativePath = module.file
        ? (isAbsolute(module.file) ? relative(this.projectPath, module.file) : module.file)
        : '';

      for (const pattern of patterns) {
        if (minimatch(relativePath, pattern) || minimatch(module.file || '', pattern)) {
          await this.graph.addEdge({
            type: 'GOVERNS',
            src: guaranteeId,
            dst: module.id
          });
          break; // Один edge на модуль
        }
      }
    }
  }

  /**
   * Проверить есть ли изменения между версиями гарантии
   */
  private _hasChanges(
    graphG: GuaranteeNode,
    fileG: { rule: string; severity: GuaranteeSeverity; name: string; governs: string[] }
  ): boolean {
    return (
      graphG.rule !== fileG.rule ||
      graphG.severity !== fileG.severity ||
      graphG.name !== fileG.name ||
      JSON.stringify(graphG.governs) !== JSON.stringify(fileG.governs)
    );
  }

  /**
   * Описать изменения между версиями
   */
  private _describeChanges(
    graphG: GuaranteeNode,
    fileG: { rule: string; severity: GuaranteeSeverity; name: string; governs: string[] }
  ): string[] {
    const changes: string[] = [];
    if (graphG.rule !== fileG.rule) changes.push('rule');
    if (graphG.severity !== fileG.severity) changes.push('severity');
    if (graphG.name !== fileG.name) changes.push('name');
    if (JSON.stringify(graphG.governs) !== JSON.stringify(fileG.governs)) changes.push('governs');
    return changes;
  }
}
