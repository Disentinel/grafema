// Basic path-sensitive value set test

// Variable with unknown source (function call)
const action = getAction();

// Object with methods
const obj = {
  save() {
    console.log('saving');
  },
  delete() {
    console.log('deleting');
  }
};

// Simple equality constraint
if (action === "save") {
  // Inside this scope: action === "save"
  obj[action](); // Should resolve to obj.save()
  console.log(action);
}

// Another equality constraint
if (action === "delete") {
  // Inside this scope: action === "delete"
  obj[action](); // Should resolve to obj.delete()
}

// Inequality constraint (exclusion)
if (action !== "save") {
  // Inside this scope: action !== "save" (excludes "save")
  console.log('not save:', action);
}

// Loose equality
const status = getStatus();
if (status == "active") {
  console.log('active status');
}
