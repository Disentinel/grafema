export function renderUserList(users) {
  console.log(`Rendering ${users.length} users`);

  const html = users.map(user => `
    <div class="user">
      <h3>${user.name}</h3>
      <p>${user.email}</p>
    </div>
  `).join('');

  return html;
}
