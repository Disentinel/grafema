/**
 * Basic functional component with props
 * Tests: COMPONENT node, RENDERS edge, PASSES_PROP edge
 */
import React from 'react';

function Button({ label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

function App() {
  function handleClick() {
    console.log('clicked');
  }

  return (
    <div className="app">
      <h1>Hello</h1>
      <Button
        label="Click me"
        onClick={handleClick}
        disabled={false}
      />
    </div>
  );
}

export default App;
