export interface FlowPreset {
  types: string[];
  color: number;
  label: string;
  alwaysOn?: boolean;
}

export const FLOWS: Record<string, FlowPreset> = {
  data: {
    // CO_DEPENDS_ON is the compaction-enricher synthetic edge — pairs of
    // functions reading the same module-scope CONSTANT/VARIABLE. Lives
    // under Data Flow because it captures implicit data coupling.
    types: ['ASSIGNED_FROM', 'FLOWS_INTO', 'READS_FROM', 'WRITES_TO', 'PASSES_ARGUMENT', 'CO_DEPENDS_ON'],
    color: 0xaa66ff,
    label: 'Data Flow',
  },
  calls: {
    // CO_CALLS is the compaction-enricher synthetic edge — pairs of
    // functions that share a callee (mirror of CO_DEPENDS_ON for the
    // call graph). Visualises behavioural co-dependency clusters.
    types: ['CALLS', 'CALLS_ON', 'HANDLED_BY', 'ROUTES_TO', 'CO_CALLS'],
    color: 0xff4466,
    label: 'Call Flow',
  },
  deps: {
    types: ['IMPORTS_FROM', 'DEPENDS_ON', 'EXTENDS', 'IMPLEMENTS'],
    color: 0x00d4ff,
    label: 'Dependencies',
  },
  bridges: {
    types: ['REMOTE_CALL', 'CROSS_BOUNDARY'],
    color: 0x00ffaa,
    label: 'Bridges',
    alwaysOn: true,
  },
};
