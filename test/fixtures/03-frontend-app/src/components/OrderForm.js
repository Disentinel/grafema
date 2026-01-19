import { createOrder } from '../api.js';

export function renderOrderForm() {
  console.log('Rendering order form');

  return `
    <form id="order-form">
      <input name="userId" placeholder="User ID" />
      <textarea name="items" placeholder="Items (JSON)"></textarea>
      <button type="submit">Create Order</button>
    </form>
  `;
}

export async function handleOrderSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const userId = formData.get('userId');
  const items = JSON.parse(formData.get('items'));

  await createOrder(userId, items);
  console.log('Order created successfully');
}
