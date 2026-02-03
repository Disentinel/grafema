/**
 * Test fixture for FetchAnalyzer (REG-252 Phase B)
 *
 * Demonstrates various fetch patterns with response consumption:
 * - await fetch(url) with response.json()
 * - await fetch(url) with response.text()
 * - Different variable names for response
 * - Multiple fetch calls
 * - POST requests with response.json()
 *
 * Note: URLs match backend routes exactly (e.g., /users matches router.get('/users'))
 */

// Pattern 1: Basic fetch with response.json()
export async function getUsers() {
  const response = await fetch('/users');
  const data = await response.json();
  return data;
}

// Pattern 2: POST fetch with response.json() - matches router.post('/items')
export async function createItem(itemData) {
  const response = await fetch('/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(itemData)
  });
  const created = await response.json();
  return created;
}

// Pattern 3: Different variable name (res instead of response)
export async function getStatus() {
  const res = await fetch('/status');
  const status = await res.json();
  return status;
}

// Pattern 4: response.text() pattern (no matching backend route - will not create HTTP_RECEIVES)
export async function getHtml() {
  const response = await fetch('/content');
  const html = await response.text();
  return html;
}

// Pattern 5: No response consumption (just check ok)
export async function checkHealth() {
  const response = await fetch('/health');
  return response.ok;
}

// Pattern 6: Multiple fetch calls in one function
export async function getDashboardData() {
  const usersResponse = await fetch('/users');
  const users = await usersResponse.json();

  const itemsResponse = await fetch('/items', { method: 'POST', body: '{}' });
  const items = await itemsResponse.json();

  return { users, items };
}

// Pattern 7: Fetch single item by ID (parametric URL - matches /item/:id)
export async function getItem(id) {
  const response = await fetch(`/item/${id}`);
  const item = await response.json();
  return item;
}

// Pattern 8: response.blob() for file download (no matching backend route)
export async function downloadFile(fileId) {
  const response = await fetch(`/files/${fileId}`);
  const blob = await response.blob();
  return blob;
}
