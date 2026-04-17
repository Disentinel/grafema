import { useCallback } from 'react';
import { useDiffStore, type NodeChange } from '../store/diffStore';
import { useDataStore } from '../store/dataStore';

export function DiffPanel() {
  const { active, added, removed, changed, enterDiff, exitDiff } = useDiffStore();
  const nodes = useDataStore((s) => s.nodes);

  const loadDiff = useCallback(async () => {
    const resp = await fetch('./fixtures/diff-v2.json');
    const diff = await resp.json();

    // Resolve IDs to indices
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) {
      idToIdx.set(nodes[i].id, i);
    }

    const addedIdx: number[] = [];
    // For added nodes, we'd need to add them to the graph — for now just mark
    // a nearby existing node as "added" placeholder
    // In real usage, added nodes would be injected into the hex grid

    const removedIdx: number[] = [];
    for (const rid of (diff.removed as string[])) {
      const idx = idToIdx.get(rid);
      if (idx !== undefined) removedIdx.push(idx);
    }

    const changedMap = new Map<number, NodeChange[]>();
    for (const c of (diff.changed as { id: string; changes: Record<string, [number, number]> }[])) {
      const idx = idToIdx.get(c.id);
      if (idx === undefined) continue;
      const changes: NodeChange[] = [];
      for (const [field, [from, to]] of Object.entries(c.changes)) {
        changes.push({ field, from, to });
      }
      changedMap.set(idx, changes);
    }

    enterDiff(addedIdx, removedIdx, changedMap);
  }, [nodes, enterDiff]);

  return (
    <div>
      <h2>Diff</h2>
      {!active ? (
        <button
          onClick={loadDiff}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 4,
            border: '1px solid #555',
            background: '#111',
            color: '#888',
            cursor: 'pointer',
            marginTop: 4,
          }}
        >
          Load v2 diff
        </button>
      ) : (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>
            {added.size > 0 && <span style={{ color: '#22cc66' }}>+{added.size} added </span>}
            {removed.size > 0 && <span style={{ color: '#ff4466' }}>-{removed.size} removed </span>}
            {changed.size > 0 && <span style={{ color: '#ffaa00' }}>~{changed.size} changed</span>}
          </div>
          {changed.size > 0 && (
            <div style={{ fontSize: 10, color: '#555' }}>
              {[...changed.entries()].map(([idx, changes]) => (
                <div key={idx}>
                  {nodes[idx]?.name}: {changes.map(c => `${c.field} ${c.from}→${c.to}`).join(', ')}
                </div>
              ))}
            </div>
          )}
          <button
            onClick={exitDiff}
            style={{
              padding: '3px 8px',
              fontSize: 10,
              borderRadius: 4,
              border: '1px solid #ff4466',
              background: '#ff446622',
              color: '#ff4466',
              cursor: 'pointer',
              marginTop: 6,
            }}
          >
            Exit diff
          </button>
        </div>
      )}
    </div>
  );
}
