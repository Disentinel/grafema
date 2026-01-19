import { fetchUsers } from './api.js';
import { renderUserList } from './components/UserList.js';
import { renderOrderForm } from './components/OrderForm.js';

async function init() {
  console.log('Initializing app...');

  try {
    const users = await fetchUsers();
    renderUserList(users);
    renderOrderForm();
  } catch (error) {
    console.error('Failed to initialize:', error);
  }
}

init();
