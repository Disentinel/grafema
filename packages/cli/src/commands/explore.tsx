/**
 * Explore command - Interactive TUI or batch mode for graph navigation
 *
 * Interactive mode: grafema explore [start]
 * Batch mode:
 *   grafema explore --query "functionName"
 *   grafema explore --callers "functionName"
 *   grafema explore --callees "functionName"
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { RFDBServerBackend } from '@grafema/core';
import { getCodePreview, formatCodePreview } from '../utils/codePreview.js';
import { exitWithError } from '../utils/errorFormatter.js';

// Types
interface ExploreOptions {
  project: string;
  // Batch mode flags
  query?: string;
  callers?: string;
  callees?: string;
  depth?: string;
  json?: boolean;
  format?: 'json' | 'text';
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  // Function-specific fields
  async?: boolean;
  exported?: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  params?: string[];
  paramTypes?: string[];
  returnType?: string;
  signature?: string;
  jsdocSummary?: string;
}

interface ExploreState {
  currentNode: NodeInfo | null;
  callers: NodeInfo[];
  callees: NodeInfo[];
  // For CLASS nodes
  fields: NodeInfo[];
  methods: NodeInfo[];
  // For VARIABLE/field data flow
  dataFlowSources: NodeInfo[];
  dataFlowTargets: NodeInfo[];
  breadcrumbs: NodeInfo[];
  selectedIndex: number;
  selectedPanel: 'callers' | 'callees' | 'search' | 'modules' | 'fields' | 'methods' | 'sources' | 'targets';
  searchMode: boolean;
  searchQuery: string;
  searchResults: NodeInfo[];
  modules: NodeInfo[];
  loading: boolean;
  error: string | null;
  visibleCallers: number;
  visibleCallees: number;
  viewMode: 'function' | 'search' | 'modules' | 'class' | 'dataflow';
  // Code preview
  showCodePreview: boolean;
  codePreviewLines: string[];
}

interface ExplorerProps {
  backend: RFDBServerBackend;
  startNode: NodeInfo | null;
  projectPath: string;
}

// Main Explorer Component
function Explorer({ backend, startNode, projectPath }: ExplorerProps) {
  const { exit } = useApp();

  const [state, setState] = useState<ExploreState>({
    currentNode: startNode,
    callers: [],
    callees: [],
    fields: [],
    methods: [],
    dataFlowSources: [],
    dataFlowTargets: [],
    breadcrumbs: startNode ? [startNode] : [],
    selectedIndex: 0,
    selectedPanel: 'callers',
    searchMode: false,
    searchQuery: '',
    searchResults: [],
    modules: [],
    loading: true,
    error: null,
    visibleCallers: 10,
    visibleCallees: 10,
    viewMode: 'function',
    showCodePreview: false,
    codePreviewLines: [],
  });

  // Load data when currentNode changes
  useEffect(() => {
    if (!state.currentNode) return;

    const load = async () => {
      setState(s => ({ ...s, loading: true }));

      try {
        const nodeType = state.currentNode!.type;

        if (nodeType === 'CLASS') {
          // Load fields and methods for class
          const { fields, methods } = await getClassMembers(backend, state.currentNode!.id);
          setState(s => ({
            ...s,
            fields,
            methods,
            viewMode: 'class',
            selectedPanel: 'fields',
            loading: false,
            selectedIndex: 0,
          }));
        } else if (nodeType === 'VARIABLE' || nodeType === 'PARAMETER') {
          // Load data flow for variable
          const { sources, targets } = await getDataFlow(backend, state.currentNode!.id);
          setState(s => ({
            ...s,
            dataFlowSources: sources,
            dataFlowTargets: targets,
            viewMode: 'dataflow',
            selectedPanel: 'sources',
            loading: false,
            selectedIndex: 0,
          }));
        } else {
          // Load callers/callees for function
          const callers = await getCallers(backend, state.currentNode!.id, 50);
          const callees = await getCallees(backend, state.currentNode!.id, 50);
          setState(s => ({
            ...s,
            callers,
            callees,
            viewMode: 'function',
            selectedPanel: 'callers',
            loading: false,
            selectedIndex: 0,
            visibleCallers: 10,
            visibleCallees: 10,
          }));
        }
      } catch (err) {
        setState(s => ({
          ...s,
          error: (err as Error).message,
          loading: false,
        }));
      }
    };

    load();
  }, [state.currentNode?.id]);

  // Get current list based on view mode and panel
  const getCurrentList = (): NodeInfo[] => {
    if (state.viewMode === 'search') return state.searchResults;
    if (state.viewMode === 'modules') return state.modules;
    if (state.viewMode === 'class') {
      return state.selectedPanel === 'fields' ? state.fields : state.methods;
    }
    if (state.viewMode === 'dataflow') {
      return state.selectedPanel === 'sources' ? state.dataFlowSources : state.dataFlowTargets;
    }
    return state.selectedPanel === 'callers' ? state.callers : state.callees;
  };

  // Keyboard input
  useInput((input, key) => {
    if (state.searchMode) {
      if (key.escape) {
        setState(s => ({ ...s, searchMode: false, searchQuery: '' }));
      } else if (key.return) {
        performSearch(state.searchQuery);
        setState(s => ({ ...s, searchMode: false }));
      } else if (key.backspace || key.delete) {
        setState(s => ({ ...s, searchQuery: s.searchQuery.slice(0, -1) }));
      } else if (input && !key.ctrl && !key.meta) {
        setState(s => ({ ...s, searchQuery: s.searchQuery + input }));
      }
      return;
    }

    // Normal mode
    if (input === 'q') {
      exit();
      return;
    }

    if (input === '/') {
      setState(s => ({ ...s, searchMode: true, searchQuery: '' }));
      return;
    }

    if (input === '?') {
      // TODO: show help
      return;
    }

    // 'm' - show modules view
    if (input === 'm') {
      loadModules();
      return;
    }

    // Space - toggle code preview
    if (input === ' ') {
      if (state.currentNode && state.currentNode.file && state.currentNode.line) {
        if (state.showCodePreview) {
          // Hide code preview
          setState(s => ({ ...s, showCodePreview: false, codePreviewLines: [] }));
        } else {
          // Show code preview
          const preview = getCodePreview({
            file: state.currentNode.file,
            line: state.currentNode.line,
          });
          if (preview) {
            const formatted = formatCodePreview(preview, state.currentNode.line);
            setState(s => ({ ...s, showCodePreview: true, codePreviewLines: formatted }));
          }
        }
      }
      return;
    }

    // 'o' - open in editor
    if (input === 'o') {
      if (state.currentNode && state.currentNode.file) {
        const editor = process.env.EDITOR || 'code';
        const file = state.currentNode.file;
        const line = state.currentNode.line;
        try {
          if (editor.includes('code')) {
            // VS Code supports --goto
            execSync(`${editor} --goto "${file}:${line || 1}"`, { stdio: 'ignore' });
          } else {
            // Generic editor
            execSync(`${editor} +${line || 1} "${file}"`, { stdio: 'ignore' });
          }
        } catch {
          // Ignore editor errors
        }
      }
      return;
    }

    // Arrow keys for panel switching
    if (key.leftArrow || input === 'h') {
      if (state.viewMode === 'function') {
        setState(s => ({ ...s, selectedPanel: 'callers', selectedIndex: 0 }));
      } else if (state.viewMode === 'class') {
        setState(s => ({ ...s, selectedPanel: 'fields', selectedIndex: 0 }));
      } else if (state.viewMode === 'dataflow') {
        setState(s => ({ ...s, selectedPanel: 'sources', selectedIndex: 0 }));
      }
      return;
    }

    if (key.rightArrow || input === 'l') {
      if (state.viewMode === 'function') {
        setState(s => ({ ...s, selectedPanel: 'callees', selectedIndex: 0 }));
      } else if (state.viewMode === 'class') {
        setState(s => ({ ...s, selectedPanel: 'methods', selectedIndex: 0 }));
      } else if (state.viewMode === 'dataflow') {
        setState(s => ({ ...s, selectedPanel: 'targets', selectedIndex: 0 }));
      }
      return;
    }

    // Up arrow - works in all modes
    if (key.upArrow || input === 'k') {
      setState(s => ({
        ...s,
        selectedIndex: Math.max(0, s.selectedIndex - 1),
      }));
      return;
    }

    // Down arrow - works in all modes
    if (key.downArrow || input === 'j') {
      const list = getCurrentList();
      setState(s => {
        const newIndex = Math.min(list.length - 1, s.selectedIndex + 1);
        return { ...s, selectedIndex: newIndex };
      });
      return;
    }

    // Enter - select item
    if (key.return) {
      const list = getCurrentList();
      const selected = list[state.selectedIndex];
      if (selected) {
        // Don't navigate into recursive calls (same function)
        if (selected.id !== state.currentNode?.id) {
          navigateTo(selected);
          setState(s => ({ ...s, viewMode: 'function', selectedPanel: 'callers' }));
        }
      }
      return;
    }

    if (key.backspace || key.delete) {
      goBack();
      return;
    }

    if (input === 'tab') {
      setState(s => ({
        ...s,
        selectedPanel: s.selectedPanel === 'callers' ? 'callees' : 'callers',
        selectedIndex: 0,
      }));
      return;
    }
  });

  const navigateTo = (node: NodeInfo) => {
    setState(s => ({
      ...s,
      currentNode: node,
      breadcrumbs: [...s.breadcrumbs, node],
      selectedIndex: 0,
    }));
  };

  const goBack = () => {
    // From search/modules view, go back to function view
    if (state.viewMode !== 'function') {
      setState(s => ({
        ...s,
        viewMode: 'function',
        selectedPanel: 'callers',
        selectedIndex: 0,
      }));
      return;
    }

    // From function view with breadcrumbs, go back
    if (state.breadcrumbs.length > 1) {
      const newBreadcrumbs = state.breadcrumbs.slice(0, -1);
      const previousNode = newBreadcrumbs[newBreadcrumbs.length - 1];

      setState(s => ({
        ...s,
        currentNode: previousNode,
        breadcrumbs: newBreadcrumbs,
        selectedIndex: 0,
      }));
    }
  };

  const performSearch = async (query: string) => {
    if (!query.trim()) return;

    setState(s => ({ ...s, loading: true }));

    try {
      const results = await searchNodes(backend, query, 20);
      setState(s => ({
        ...s,
        searchResults: results,
        viewMode: 'search',
        selectedPanel: 'search',
        selectedIndex: 0,
        loading: false,
        error: results.length === 0 ? `No results for "${query}"` : null,
      }));
    } catch (err) {
      setState(s => ({
        ...s,
        error: (err as Error).message,
        loading: false,
      }));
    }
  };

  const loadModules = async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const modules = await getModules(backend, 50);
      setState(s => ({
        ...s,
        modules,
        viewMode: 'modules',
        selectedPanel: 'modules',
        selectedIndex: 0,
        loading: false,
      }));
    } catch (err) {
      setState(s => ({
        ...s,
        error: (err as Error).message,
        loading: false,
      }));
    }
  };

  const formatLoc = (node: NodeInfo) => {
    if (!node.file) return '';
    const rel = relative(projectPath, node.file);
    return node.line ? `${rel}:${node.line}` : rel;
  };

  // Render
  if (!state.currentNode) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">No function selected.</Text>
        <Text>Press / to search, q to quit.</Text>
        {state.searchMode && (
          <Box marginTop={1}>
            <Text>Search: </Text>
            <Text color="cyan">{state.searchQuery}</Text>
            <Text color="gray">_</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Build badges for current node
  const badges: string[] = [];
  if (state.currentNode.async) badges.push('async');
  if (state.currentNode.exported) badges.push('exp');
  if (state.currentNode.generator) badges.push('gen');
  if (state.currentNode.arrowFunction) badges.push('arrow');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
      {/* Header with badges */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Grafema Explorer</Text>
        {state.loading && <Text color="yellow"> (loading...)</Text>}
        {badges.length > 0 && (
          <Text>
            {'  '}
            {badges.map((badge, i) => (
              <Text key={`badge-${i}`}>
                <Text color="magenta">[{badge}]</Text>
                {i < badges.length - 1 ? ' ' : ''}
              </Text>
            ))}
          </Text>
        )}
      </Box>

      {/* Breadcrumbs */}
      <Box marginBottom={1}>
        <Text color="gray">
          {state.breadcrumbs.map((b, i) => (
            <Text key={`bc-${i}-${b.id}`}>
              {i > 0 ? ' → ' : ''}
              <Text color={i === state.breadcrumbs.length - 1 ? 'white' : 'gray'}>
                {b.name}
              </Text>
            </Text>
          ))}
        </Text>
      </Box>

      {/* Current node info with signature */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green" bold>{state.currentNode.type}</Text>
          <Text>: </Text>
          <Text bold>{state.currentNode.name}</Text>
        </Text>
        {state.currentNode.signature && (
          <Text color="yellow">{state.currentNode.signature}</Text>
        )}
        {state.currentNode.jsdocSummary && (
          <Text color="gray" italic>  {state.currentNode.jsdocSummary}</Text>
        )}
        <Text color="gray">{formatLoc(state.currentNode)}</Text>
      </Box>

      {/* Content based on view mode */}
      {state.viewMode === 'search' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Search Results ({state.searchResults.length}):</Text>
          {state.searchResults.length === 0 ? (
            <Text color="gray">  No results</Text>
          ) : (
            state.searchResults.map((item, i) => (
              <Text key={`search-${i}-${item.id}`}>
                {i === state.selectedIndex ? (
                  <Text color="cyan" bold>{'> '}</Text>
                ) : (
                  <Text>{'  '}</Text>
                )}
                <Text color={i === state.selectedIndex ? 'white' : 'gray'}>
                  <Text color="green">{item.type}</Text> {item.name}
                </Text>
                <Text color="gray" dimColor> {formatLoc(item)}</Text>
              </Text>
            ))
          )}
        </Box>
      )}

      {state.viewMode === 'modules' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Modules ({state.modules.length}):</Text>
          {state.modules.length === 0 ? (
            <Text color="gray">  No modules</Text>
          ) : (
            state.modules.slice(0, 20).map((mod, i) => (
              <Text key={`mod-${i}-${mod.id}`}>
                {i === state.selectedIndex ? (
                  <Text color="cyan" bold>{'> '}</Text>
                ) : (
                  <Text>{'  '}</Text>
                )}
                <Text color={i === state.selectedIndex ? 'white' : 'gray'}>
                  {formatLoc(mod)}
                </Text>
              </Text>
            ))
          )}
          {state.modules.length > 20 && (
            <Text color="gray">  ↓ {state.modules.length - 20} more</Text>
          )}
        </Box>
      )}

      {state.viewMode === 'function' && (
        <Box>
          {/* Callers column */}
          <Box flexDirection="column" width="50%" paddingRight={1}>
            <Text bold color={state.selectedPanel === 'callers' ? 'cyan' : 'gray'}>
              Called by ({state.callers.length}):
            </Text>
            {state.callers.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.callers.slice(0, state.visibleCallers).map((caller, i) => {
                const isRecursive = caller.id === state.currentNode?.id;
                return (
                  <Text key={`caller-${i}-${caller.id}`}>
                    {state.selectedPanel === 'callers' && i === state.selectedIndex ? (
                      <Text color="cyan" bold>{'> '}</Text>
                    ) : (
                      <Text>{'  '}</Text>
                    )}
                    <Text color={isRecursive ? 'yellow' : (state.selectedPanel === 'callers' && i === state.selectedIndex ? 'white' : 'gray')}>
                      {caller.name}{isRecursive ? ' ↻' : ''}
                    </Text>
                  </Text>
                );
              })
            )}
            {state.callers.length > state.visibleCallers && (
              <Text color="gray">  ↓ {state.callers.length - state.visibleCallers} more</Text>
            )}
          </Box>

          {/* Callees column */}
          <Box flexDirection="column" width="50%" paddingLeft={1}>
            <Text bold color={state.selectedPanel === 'callees' ? 'cyan' : 'gray'}>
              Calls ({state.callees.length}):
            </Text>
            {state.callees.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.callees.slice(0, state.visibleCallees).map((callee, i) => {
                const isRecursive = callee.id === state.currentNode?.id;
                return (
                  <Text key={`callee-${i}-${callee.id}`}>
                    {state.selectedPanel === 'callees' && i === state.selectedIndex ? (
                      <Text color="cyan" bold>{'> '}</Text>
                    ) : (
                      <Text>{'  '}</Text>
                    )}
                    <Text color={isRecursive ? 'yellow' : (state.selectedPanel === 'callees' && i === state.selectedIndex ? 'white' : 'gray')}>
                      {callee.name}{isRecursive ? ' ↻' : ''}
                    </Text>
                  </Text>
                );
              })
            )}
            {state.callees.length > state.visibleCallees && (
              <Text color="gray">  ↓ {state.callees.length - state.visibleCallees} more</Text>
            )}
          </Box>
        </Box>
      )}

      {state.viewMode === 'class' && (
        <Box>
          {/* Fields column */}
          <Box flexDirection="column" width="50%" paddingRight={1}>
            <Text bold color={state.selectedPanel === 'fields' ? 'cyan' : 'gray'}>
              Fields ({state.fields.length}):
            </Text>
            {state.fields.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.fields.slice(0, 15).map((field, i) => (
                <Text key={`field-${i}-${field.id}`}>
                  {state.selectedPanel === 'fields' && i === state.selectedIndex ? (
                    <Text color="cyan" bold>{'> '}</Text>
                  ) : (
                    <Text>{'  '}</Text>
                  )}
                  <Text color={state.selectedPanel === 'fields' && i === state.selectedIndex ? 'white' : 'gray'}>
                    {field.name}
                  </Text>
                </Text>
              ))
            )}
            {state.fields.length > 15 && (
              <Text color="gray">  ↓ {state.fields.length - 15} more</Text>
            )}
          </Box>

          {/* Methods column */}
          <Box flexDirection="column" width="50%" paddingLeft={1}>
            <Text bold color={state.selectedPanel === 'methods' ? 'cyan' : 'gray'}>
              Methods ({state.methods.length}):
            </Text>
            {state.methods.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.methods.slice(0, 15).map((method, i) => (
                <Text key={`method-${i}-${method.id}`}>
                  {state.selectedPanel === 'methods' && i === state.selectedIndex ? (
                    <Text color="cyan" bold>{'> '}</Text>
                  ) : (
                    <Text>{'  '}</Text>
                  )}
                  <Text color={state.selectedPanel === 'methods' && i === state.selectedIndex ? 'white' : 'gray'}>
                    {method.name}()
                  </Text>
                </Text>
              ))
            )}
            {state.methods.length > 15 && (
              <Text color="gray">  ↓ {state.methods.length - 15} more</Text>
            )}
          </Box>
        </Box>
      )}

      {state.viewMode === 'dataflow' && (
        <Box>
          {/* Sources column (where data comes from) */}
          <Box flexDirection="column" width="50%" paddingRight={1}>
            <Text bold color={state.selectedPanel === 'sources' ? 'cyan' : 'gray'}>
              Data from ({state.dataFlowSources.length}):
            </Text>
            {state.dataFlowSources.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.dataFlowSources.slice(0, 15).map((src, i) => (
                <Text key={`src-${i}-${src.id}`}>
                  {state.selectedPanel === 'sources' && i === state.selectedIndex ? (
                    <Text color="cyan" bold>{'> '}</Text>
                  ) : (
                    <Text>{'  '}</Text>
                  )}
                  <Text color={state.selectedPanel === 'sources' && i === state.selectedIndex ? 'white' : 'gray'}>
                    ← {src.name} <Text dimColor>({src.type})</Text>
                  </Text>
                </Text>
              ))
            )}
          </Box>

          {/* Targets column (where data flows to) */}
          <Box flexDirection="column" width="50%" paddingLeft={1}>
            <Text bold color={state.selectedPanel === 'targets' ? 'cyan' : 'gray'}>
              Flows to ({state.dataFlowTargets.length}):
            </Text>
            {state.dataFlowTargets.length === 0 ? (
              <Text color="gray">  (none)</Text>
            ) : (
              state.dataFlowTargets.slice(0, 15).map((tgt, i) => (
                <Text key={`tgt-${i}-${tgt.id}`}>
                  {state.selectedPanel === 'targets' && i === state.selectedIndex ? (
                    <Text color="cyan" bold>{'> '}</Text>
                  ) : (
                    <Text>{'  '}</Text>
                  )}
                  <Text color={state.selectedPanel === 'targets' && i === state.selectedIndex ? 'white' : 'gray'}>
                    → {tgt.name} <Text dimColor>({tgt.type})</Text>
                  </Text>
                </Text>
              ))
            )}
          </Box>
        </Box>
      )}

      {/* Code Preview Panel */}
      {state.showCodePreview && state.codePreviewLines.length > 0 && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Code Preview:</Text>
          {state.codePreviewLines.map((line, i) => (
            <Text key={`code-${i}`} color={line.startsWith('>') ? 'white' : 'gray'}>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {/* Error message */}
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}

      {/* Search mode */}
      {state.searchMode && (
        <Box marginTop={1}>
          <Text>Search: </Text>
          <Text color="cyan">{state.searchQuery}</Text>
          <Text color="gray">_</Text>
        </Box>
      )}

      {/* Help footer */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">
          ↑↓: Select | ←→: Panel | Enter: Open | Backspace: Back | /: Search | m: Modules | Space: Code | o: Editor | q: Quit
        </Text>
      </Box>
    </Box>
  );
}

// Helper function to extract NodeInfo with extended fields from a raw node
function extractNodeInfo(node: any): NodeInfo {
  const nodeType = node.type || node.nodeType || 'UNKNOWN';
  return {
    id: node.id,
    type: nodeType,
    name: node.name || '<anonymous>',
    file: node.file || '',
    line: node.line,
    // Function-specific fields
    async: node.async,
    exported: node.exported,
    generator: node.generator,
    arrowFunction: node.arrowFunction,
    params: node.params,
    paramTypes: node.paramTypes,
    returnType: node.returnType,
    signature: node.signature,
    jsdocSummary: node.jsdocSummary,
  };
}

// Helper functions
async function getCallers(backend: RFDBServerBackend, nodeId: string, limit: number): Promise<NodeInfo[]> {
  const callers: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    const callEdges = await backend.getIncomingEdges(nodeId, ['CALLS']);

    for (const edge of callEdges) {
      if (callers.length >= limit) break;

      const callNode = await backend.getNode(edge.src);
      if (!callNode) continue;

      const containingFunc = await findContainingFunction(backend, callNode.id);

      if (containingFunc && !seen.has(containingFunc.id)) {
        seen.add(containingFunc.id);
        callers.push(containingFunc);
      }
    }
  } catch {
    // Ignore
  }

  return callers;
}

async function getCallees(backend: RFDBServerBackend, nodeId: string, limit: number): Promise<NodeInfo[]> {
  const callees: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    const callNodes = await findCallsInFunction(backend, nodeId);

    for (const callNode of callNodes) {
      if (callees.length >= limit) break;

      const callEdges = await backend.getOutgoingEdges(callNode.id, ['CALLS']);

      for (const edge of callEdges) {
        if (callees.length >= limit) break;

        const targetNode = await backend.getNode(edge.dst);
        if (!targetNode || seen.has(targetNode.id)) continue;

        seen.add(targetNode.id);
        callees.push(extractNodeInfo(targetNode));
      }
    }
  } catch {
    // Ignore
  }

  return callees;
}

async function findContainingFunction(backend: RFDBServerBackend, nodeId: string): Promise<NodeInfo | null> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > 15) continue;
    visited.add(id);

    try {
      const edges = await backend.getIncomingEdges(id, null);

      for (const edge of edges) {
        if (!['CONTAINS', 'HAS_SCOPE', 'DECLARES'].includes(edge.type)) continue;

        const parent = await backend.getNode(edge.src);
        if (!parent || visited.has(parent.id)) continue;

        const parentType = (parent as any).type || (parent as any).nodeType;

        if (parentType === 'FUNCTION' || parentType === 'CLASS' || parentType === 'MODULE') {
          return extractNodeInfo(parent);
        }

        queue.push({ id: parent.id, depth: depth + 1 });
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

async function findCallsInFunction(backend: RFDBServerBackend, nodeId: string): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > 10) continue;
    visited.add(id);

    try {
      const edges = await backend.getOutgoingEdges(id, ['CONTAINS']);

      for (const edge of edges) {
        const child = await backend.getNode(edge.dst);
        if (!child) continue;

        const childType = (child as any).type || (child as any).nodeType;

        if (childType === 'CALL') {
          calls.push({
            id: child.id,
            type: 'CALL',
            name: (child as any).name || '',
            file: (child as any).file || '',
            line: (child as any).line,
          });
        }

        if (childType !== 'FUNCTION' && childType !== 'CLASS') {
          queue.push({ id: child.id, depth: depth + 1 });
        }
      }
    } catch {
      // Ignore
    }
  }

  return calls;
}

async function searchNode(backend: RFDBServerBackend, query: string): Promise<NodeInfo | null> {
  const results = await searchNodes(backend, query, 1);
  return results[0] || null;
}

async function searchNodes(backend: RFDBServerBackend, query: string, limit: number): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const lowerQuery = query.toLowerCase();

  for (const nodeType of ['FUNCTION', 'CLASS', 'MODULE']) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const name = ((node as any).name || '').toLowerCase();
      if (name === lowerQuery || name.includes(lowerQuery)) {
        results.push(extractNodeInfo(node));
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

async function getModules(backend: RFDBServerBackend, limit: number): Promise<NodeInfo[]> {
  const modules: NodeInfo[] = [];

  for await (const node of backend.queryNodes({ nodeType: 'MODULE' as any })) {
    modules.push(extractNodeInfo(node));
    if (modules.length >= limit) break;
  }

  // Sort by file path for better navigation
  modules.sort((a, b) => a.file.localeCompare(b.file));

  return modules;
}

async function getClassMembers(
  backend: RFDBServerBackend,
  classId: string
): Promise<{ fields: NodeInfo[]; methods: NodeInfo[] }> {
  const fields: NodeInfo[] = [];
  const methods: NodeInfo[] = [];

  try {
    // Get children via CONTAINS edge
    const edges = await backend.getOutgoingEdges(classId, ['CONTAINS']);

    for (const edge of edges) {
      const child = await backend.getNode(edge.dst);
      if (!child) continue;

      const childType = (child as any).type || (child as any).nodeType;
      const nodeInfo = extractNodeInfo(child);

      if (childType === 'FUNCTION') {
        methods.push(nodeInfo);
      } else if (childType === 'VARIABLE' || childType === 'PARAMETER') {
        fields.push(nodeInfo);
      }
    }
  } catch {
    // Ignore
  }

  return { fields, methods };
}

async function getDataFlow(
  backend: RFDBServerBackend,
  varId: string
): Promise<{ sources: NodeInfo[]; targets: NodeInfo[] }> {
  const sources: NodeInfo[] = [];
  const targets: NodeInfo[] = [];

  try {
    // Get incoming ASSIGNED_FROM edges (where data comes from)
    const inEdges = await backend.getIncomingEdges(varId, ['ASSIGNED_FROM']);
    for (const edge of inEdges) {
      const src = await backend.getNode(edge.src);
      if (src) {
        sources.push(extractNodeInfo(src));
      }
    }

    // Get outgoing ASSIGNED_FROM edges (where data flows to)
    const outEdges = await backend.getOutgoingEdges(varId, ['ASSIGNED_FROM']);
    for (const edge of outEdges) {
      const tgt = await backend.getNode(edge.dst);
      if (tgt) {
        targets.push(extractNodeInfo(tgt));
      }
    }

    // Also check DERIVES_FROM for additional flow info
    const derivesIn = await backend.getIncomingEdges(varId, ['DERIVES_FROM']);
    for (const edge of derivesIn) {
      const src = await backend.getNode(edge.src);
      if (src && !sources.find(s => s.id === src.id)) {
        sources.push(extractNodeInfo(src));
      }
    }
  } catch {
    // Ignore
  }

  return { sources, targets };
}

async function findStartNode(backend: RFDBServerBackend, startName: string | null): Promise<NodeInfo | null> {
  if (startName) {
    return searchNode(backend, startName);
  }

  // Find first function with most callers
  let bestNode: NodeInfo | null = null;
  let bestCallerCount = 0;

  let checked = 0;
  for await (const node of backend.queryNodes({ nodeType: 'FUNCTION' as any })) {
    const incoming = await backend.getIncomingEdges(node.id, ['CALLS']);
    if (incoming.length > bestCallerCount) {
      bestCallerCount = incoming.length;
      bestNode = extractNodeInfo(node);
    }

    checked++;
    if (checked >= 100) break; // Limit search
  }

  return bestNode;
}

// =============================================================================
// Batch Mode Implementation
// =============================================================================

/**
 * Run explore in batch mode - for AI agents, CI, and scripts
 */
async function runBatchExplore(
  backend: RFDBServerBackend,
  options: ExploreOptions,
  projectPath: string
): Promise<void> {
  const depth = parseInt(options.depth || '3', 10) || 3;
  const useJson = options.json || options.format === 'json' || options.format !== 'text';

  try {
    if (options.query) {
      // Search mode
      const results = await searchNodes(backend, options.query, 20);
      outputResults(results, 'search', useJson, projectPath);
    } else if (options.callers) {
      // Callers mode
      const target = await searchNode(backend, options.callers);
      if (!target) {
        exitWithError(`Function "${options.callers}" not found`, [
          'Try: grafema query "partial-name"',
        ]);
      }
      const callers = await getCallersRecursive(backend, target.id, depth);
      outputResults(callers, 'callers', useJson, projectPath, target);
    } else if (options.callees) {
      // Callees mode
      const target = await searchNode(backend, options.callees);
      if (!target) {
        exitWithError(`Function "${options.callees}" not found`, [
          'Try: grafema query "partial-name"',
        ]);
      }
      const callees = await getCalleesRecursive(backend, target.id, depth);
      outputResults(callees, 'callees', useJson, projectPath, target);
    }
  } catch (err) {
    exitWithError(`Explore failed: ${(err as Error).message}`);
  }
}

/**
 * Output results in JSON or text format
 */
function outputResults(
  nodes: NodeInfo[],
  mode: 'search' | 'callers' | 'callees',
  useJson: boolean,
  projectPath: string,
  target?: NodeInfo
): void {
  if (useJson) {
    const output = {
      mode,
      target: target ? formatNodeForJson(target, projectPath) : undefined,
      count: nodes.length,
      results: nodes.map(n => formatNodeForJson(n, projectPath)),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Text format
    if (target) {
      console.log(`${mode === 'callers' ? 'Callers of' : 'Callees of'}: ${target.name}`);
      console.log(`File: ${relative(projectPath, target.file)}${target.line ? `:${target.line}` : ''}`);
      console.log('');
    }

    if (nodes.length === 0) {
      console.log(`  (no ${mode} found)`);
    } else {
      for (const node of nodes) {
        const loc = relative(projectPath, node.file);
        console.log(`  ${node.type} ${node.name} (${loc}${node.line ? `:${node.line}` : ''})`);
      }
    }

    console.log('');
    console.log(`Total: ${nodes.length}`);
  }
}

function formatNodeForJson(node: NodeInfo, projectPath: string): object {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    file: relative(projectPath, node.file),
    line: node.line,
    async: node.async,
    exported: node.exported,
  };
}

/**
 * Get callers recursively up to specified depth
 */
async function getCallersRecursive(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const callers = await getCallers(backend, id, 50);
    for (const caller of callers) {
      if (!visited.has(caller.id)) {
        results.push(caller);
        if (depth < maxDepth) {
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }
  }

  return results;
}

/**
 * Get callees recursively up to specified depth
 */
async function getCalleesRecursive(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const callees = await getCallees(backend, id, 50);
    for (const callee of callees) {
      if (!visited.has(callee.id)) {
        results.push(callee);
        if (depth < maxDepth) {
          queue.push({ id: callee.id, depth: depth + 1 });
        }
      }
    }
  }

  return results;
}

// =============================================================================
// Command Definition
// =============================================================================

export const exploreCommand = new Command('explore')
  .description('Interactive graph navigation (TUI) or batch query mode')
  .argument('[start]', 'Starting function name (for interactive mode)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-q, --query <name>', 'Batch: search for nodes by name')
  .option('--callers <name>', 'Batch: show callers of function')
  .option('--callees <name>', 'Batch: show callees of function')
  .option('-d, --depth <n>', 'Batch: traversal depth', '3')
  .option('-j, --json', 'Output as JSON (default for batch mode)')
  .option('--format <type>', 'Output format: json or text')
  .addHelpText('after', `
Examples:
  grafema explore                        Interactive TUI mode
  grafema explore "authenticate"         Start TUI at specific function
  grafema explore --query "User"         Batch: search for nodes
  grafema explore --callers "login"      Batch: show who calls login
  grafema explore --callees "main"       Batch: show what main calls
  grafema explore --callers "auth" -d 5  Batch: callers with depth 5
  grafema explore --query "api" --format text   Batch: text output
`)
  .action(async (start: string | undefined, options: ExploreOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No database found', [
        'Run: grafema analyze',
      ]);
    }

    const backend = new RFDBServerBackend({ dbPath });

    try {
      await backend.connect();

      // Detect batch mode
      const isBatchMode = !!(options.query || options.callers || options.callees);

      if (isBatchMode) {
        await runBatchExplore(backend, options, projectPath);
        return;
      }

      // Interactive mode - check TTY
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;

      if (!isTTY) {
        exitWithError('Interactive mode requires a terminal', [
          'Batch mode: grafema explore --query "functionName"',
          'Batch mode: grafema explore --callers "functionName"',
          'Batch mode: grafema explore --callees "functionName"',
          'Alternative: grafema query "functionName"',
          'Alternative: grafema impact "functionName"',
        ]);
      }

      const startNode = await findStartNode(backend, start || null);

      const { waitUntilExit } = render(
        <Explorer
          backend={backend}
          startNode={startNode}
          projectPath={projectPath}
        />
      );

      await waitUntilExit();
    } finally {
      await backend.close();
    }
  });
