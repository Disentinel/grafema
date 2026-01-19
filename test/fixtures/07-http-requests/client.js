/**
 * HTTP Requests - test fixture
 * Паттерны: fetch, axios, custom wrappers
 */

// Native fetch API
async function fetchUsers() {
  const response = await fetch('/api/users');
  const data = await response.json();
  return data;
}

// Fetch with options
async function createUser(userData) {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(userData)
  });
  return response.json();
}

// Fetch with dynamic URL
async function fetchGig(gigId) {
  const response = await fetch(`/api/gigs/${gigId}`);
  return response.json();
}

// External API
async function searchSpotify(query) {
  const response = await fetch(`https://api.spotify.com/v1/search?q=${query}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  return response.json();
}

// axios.get
async function getUsersAxios() {
  const response = await axios.get('/api/users');
  return response.data;
}

// axios.post
async function createUserAxios(userData) {
  const response = await axios.post('/api/users', userData, {
    headers: { 'Content-Type': 'application/json' }
  });
  return response.data;
}

// axios with full URL
async function fetchGitlab() {
  const response = await axios.get('https://gitlab.com/api/v4/projects');
  return response.data;
}

// Custom authenticated fetch wrapper
const authFetch = async (url, options = {}) => {
  const token = localStorage.getItem('auth_token');
  const headers = new Headers(options.headers);

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(url, { ...options, headers });
};

// Using custom wrapper
async function fetchProtectedData() {
  const response = await authFetch('/api/protected');
  return response.json();
}

// Chained fetch
async function fetchAndProcess() {
  const gigs = await fetch('/api/gigs')
    .then(res => res.json())
    .then(data => data.gigs);

  return gigs;
}

// Parallel requests
async function fetchMultiple() {
  const [users, gigs, tracks] = await Promise.all([
    fetch('/api/users').then(r => r.json()),
    fetch('/api/gigs').then(r => r.json()),
    fetch('/api/tracks').then(r => r.json())
  ]);

  return { users, gigs, tracks };
}
