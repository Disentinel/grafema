const API_BASE = 'http://localhost:3000/api';

export async function fetchUsers() {
  console.log('Fetching users from API');
  const response = await fetch(`${API_BASE}/users`);
  return response.json();
}

export async function fetchOrders() {
  console.log('Fetching orders from API');
  const response = await fetch(`${API_BASE}/orders`);
  return response.json();
}

export async function createOrder(userId, items) {
  console.log(`Creating order for user ${userId}`);
  const response = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, items })
  });
  return response.json();
}
