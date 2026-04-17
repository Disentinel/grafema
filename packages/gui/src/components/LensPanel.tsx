import { LENSES } from '../config/lenses';
import { useViewStore } from '../store/viewStore';

export function LensPanel() {
  const { lens, setLens } = useViewStore();

  return (
    <div>
      <h2>Lens</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {Object.entries(LENSES).map(([key, def]) => (
          <button
            key={key}
            onClick={() => setLens(key)}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              borderRadius: 4,
              border: lens === key ? '1px solid #00e5ff' : '1px solid #333',
              background: lens === key ? '#00e5ff22' : '#111',
              color: lens === key ? '#00e5ff' : '#888',
              cursor: 'pointer',
            }}
          >
            {def.label}
          </button>
        ))}
      </div>
    </div>
  );
}
