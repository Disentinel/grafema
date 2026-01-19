// Test computed property access tracking

const handlers = {
  save: function() { console.log('save'); },
  delete: function() { console.log('delete'); }
};

// Simple computed access with literal
const action = 'save';
const m1 = handlers[action];

// Computed access with variable
const items = [1, 2, 3];
for (let i = 0; i < items.length; i++) {
  const item = items[i];
}

// Method call with computed property
const method = 'save';
handlers[method]();
