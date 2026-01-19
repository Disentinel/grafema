// no-shadow.js - no shadowing issues

import { User, Order } from './models.js';

// Normal usage - no shadowing
const user = new User('Charlie');
user.save();

const order = new Order(['item1', 'item2']);
order.process();

// Different variable names - no conflict
const userData = { name: 'Dave' };
const orderData = { items: [] };

function createUser(name) {
  // No shadowing - using imported User correctly
  return new User(name);
}
