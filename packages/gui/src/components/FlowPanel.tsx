import { FLOWS } from '../config/flows';

function hexColor(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

interface Props {
  enabledFlows: Set<string>;
  onToggle: (name: string) => void;
}

export function FlowPanel({ enabledFlows, onToggle }: Props) {
  return (
    <div>
      <h2>Flows</h2>
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
