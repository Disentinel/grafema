/**
 * Mock database module
 */
export const db = {
  query(sql, params) {
    // Mock implementation
    return { sql, params };
  }
};
