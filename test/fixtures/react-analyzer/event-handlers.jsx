/**
 * Event handler patterns
 * Tests: dom:event nodes, HANDLES_EVENT edges
 */
import React, { useState } from 'react';

function Form() {
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);

  // Named handler
  function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
  }

  // Arrow function handler
  const handleChange = (e) => {
    setValue(e.target.value);
  };

  // Handler with closure over state
  function handleReset() {
    setValue('');
    setSubmitted(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={() => console.log('focused')}
        onBlur={() => console.log('blurred')}
      />

      {/* Conditional handler */}
      <button
        type="button"
        onClick={submitted ? handleReset : undefined}
        disabled={!submitted}
      >
        Reset
      </button>

      {/* Inline handler with multiple statements */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          console.log('clicked at', e.clientX, e.clientY);
          setValue('clicked');
        }}
      >
        Log Click
      </button>

      <button type="submit">Submit</button>
    </form>
  );
}

export default Form;
