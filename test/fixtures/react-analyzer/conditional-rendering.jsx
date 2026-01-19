/**
 * Conditional rendering patterns
 *
 * Tests: Detecting components rendered conditionally,
 * understanding the render tree with conditions
 */
import React, { useState } from 'react';

function LoadingSpinner() {
  return <div className="spinner">Loading...</div>;
}

function ErrorMessage({ error }) {
  return <div className="error">{error.message}</div>;
}

function DataList({ items }) {
  return (
    <ul>
      {items.map(item => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return <p>No items found</p>;
}

function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState([]);
  const [view, setView] = useState('list');

  // Pattern 1: && short-circuit
  // LoadingSpinner only renders when loading is true
  const loadingUI = loading && <LoadingSpinner />;

  // Pattern 2: Ternary
  // Either ErrorMessage or DataList renders
  const contentUI = error
    ? <ErrorMessage error={error} />
    : <DataList items={data} />;

  // Pattern 3: Ternary with null
  const emptyUI = data.length === 0 ? <EmptyState /> : null;

  // Pattern 4: Switch-like with object lookup
  const views = {
    list: <DataList items={data} />,
    grid: <div className="grid">{/* grid view */}</div>,
    table: <table>{/* table view */}</table>,
  };

  return (
    <div>
      {loadingUI}

      {!loading && (
        <>
          {contentUI}
          {emptyUI}

          {/* Pattern 5: Inline conditional */}
          {view === 'list' && <DataList items={data} />}

          {/* Pattern 6: Dynamic view */}
          {views[view]}
        </>
      )}
    </div>
  );
}

export default Dashboard;
