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
    types: ['CALLS', 'CALLS_ON', 'HANDLED_BY', 'ROUTES_TO'],
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
