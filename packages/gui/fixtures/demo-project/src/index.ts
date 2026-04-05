import { connect } from './db/pool';
import { createRouter } from './api/router';

const PORT = parseInt(process.env.PORT || '3000');
const DB_URL = process.env.DATABASE_URL || 'postgres://localhost/demo';

async function main() {
  connect(DB_URL);
  const routes = createRouter();
  console.log(`Server starting on port ${PORT}`);
  console.log(`${routes.length} routes registered`);
}

main().catch(console.error);
