class Database {
  constructor() {
    this.connected = false;
  }

  async connect() {
    console.log('Connecting to database...');
    // Simulate connection
    this.connected = true;
  }

  async query(sql, params = []) {
    if (!this.connected) {
      throw new Error('Database not connected');
    }
    console.log(`Executing query: ${sql}`);
    // Simulate query
    return [];
  }
}

export default new Database();
