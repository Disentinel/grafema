import { FLOWS } from '../config/flows';

function hexColor(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

interface Props {
  enabledFlows: Set<string>;
  onToggle: (name: string) => void;
  /** Replace the enabled-flows set wholesale. Used by the All / None
   *  buttons so the user doesn't have to tick four checkboxes to flip
   *  between "see every link" and "see only bridges". */
  onSetAll: (next: Set<string>) => void;
}

export function FlowPanel({ enabledFlows, onToggle, onSetAll }: Props) {
  const allNames = Object.keys(FLOWS);
  const allOn = allNames.every((n) => enabledFlows.has(n));
  const allOff = enabledFlows.size === 0;
  const btnStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '2px 8px',
    background: 'transparent',
    color: '#aaa',
    border: '1px solid #444',
    borderRadius: 3,
    cursor: 'pointer',
  };
  return (
    <div>
      <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Flows</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            onClick={() => onSetAll(new Set(allNames))}
            disabled={allOn}
            style={{ ...btnStyle, opacity: allOn ? 0.4 : 1 }}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onSetAll(new Set())}
            disabled={allOff}
            style={{ ...btnStyle, opacity: allOff ? 0.4 : 1 }}
          >
            None
          </button>
        </span>
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {Object.entries(FLOWS).map(([name, preset]) => (
          <label
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              cursor: 'pointer',
              color: enabledFlows.has(name) ? '#ccc' : '#555',
            }}
          >
            <input
              type="checkbox"
              checked={enabledFlows.has(name)}
              onChange={() => onToggle(name)}
              style={{ accentColor: hexColor(preset.color) }}
            />
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: hexColor(preset.color),
                opacity: enabledFlows.has(name) ? 1 : 0.3,
              }}
            />
            {preset.label}
          </label>
        ))}
      </div>
    </div>
  );
}
