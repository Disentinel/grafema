// Basic array mutations for integration testing
const items = [];
const first = { id: 1 };
const second = { id: 2 };

items.push(first);
items.unshift(second);
items[2] = { id: 3 };

export { items };
