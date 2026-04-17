import { useRouteStore } from '../store/routeStore';

export function RoutePanel() {
  const { routes, toggleRoute } = useRouteStore();

  if (routes.length === 0) return null;

  return (
    <div>
      <h2>Routes</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {routes.map((route) => (
          <label
            key={route.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              cursor: 'pointer',
              color: route.visible ? '#ccc' : '#555',
            }}
          >
            <input
              type="checkbox"
              checked={route.visible}
              onChange={() => toggleRoute(route.id)}
              style={{ accentColor: route.color }}
            />
            <span
              style={{
                width: 16,
                height: 3,
                borderRadius: 2,
                backgroundColor: route.color,
                opacity: route.visible ? 1 : 0.3,
              }}
            />
            {route.label}
          </label>
        ))}
      </div>
    </div>
  );
}
