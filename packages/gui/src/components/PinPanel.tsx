import { useViewStore } from '../store/viewStore';
import { useDataStore } from '../store/dataStore';

export function PinPanel() {
  const { pins, removePin } = useViewStore();
  const nodes = useDataStore((s) => s.nodes);

  if (pins.size === 0) return null;

  return (
    <div>
      <h2>Pins</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
        {[...pins.entries()].map(([id, pin]) => {
          const node = nodes.find((n) => n.id === id);
          return (
            <div
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#aaa',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pin.color, flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pin.label || node?.name || id}
              </span>
              <button
                onClick={() => removePin(id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#555',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '0 2px',
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
