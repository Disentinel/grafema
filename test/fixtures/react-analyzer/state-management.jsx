/**
 * State Management patterns
 *
 * Tests: useReducer, useContext, external stores
 */
import React, { useReducer, useContext, createContext, useState } from 'react';

// Context definition
const ThemeContext = createContext('light');
const UserContext = createContext(null);

// Reducer pattern
function counterReducer(state, action) {
  switch (action.type) {
    case 'INCREMENT':
      return { count: state.count + 1 };
    case 'DECREMENT':
      return { count: state.count - 1 };
    case 'SET':
      return { count: action.payload };
    default:
      return state;
  }
}

// Complex reducer with multiple fields
function formReducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'SET_ERROR':
      return { ...state, errors: { ...state.errors, [action.field]: action.error } };
    case 'RESET':
      return action.initialState;
    default:
      return state;
  }
}

function Counter() {
  const [state, dispatch] = useReducer(counterReducer, { count: 0 });

  return (
    <div>
      <p>Count: {state.count}</p>
      <button onClick={() => dispatch({ type: 'INCREMENT' })}>+</button>
      <button onClick={() => dispatch({ type: 'DECREMENT' })}>-</button>
      <button onClick={() => dispatch({ type: 'SET', payload: 0 })}>Reset</button>
    </div>
  );
}

function Form() {
  const [state, dispatch] = useReducer(formReducer, {
    name: '',
    email: '',
    errors: {}
  });

  function handleChange(e) {
    dispatch({
      type: 'SET_FIELD',
      field: e.target.name,
      value: e.target.value
    });
  }

  return (
    <form>
      <input name="name" value={state.name} onChange={handleChange} />
      <input name="email" value={state.email} onChange={handleChange} />
    </form>
  );
}

// Context consumer
function ThemedButton() {
  const theme = useContext(ThemeContext);
  const user = useContext(UserContext);

  return (
    <button className={theme}>
      {user ? user.name : 'Guest'}
    </button>
  );
}

// Context provider
function App() {
  const [theme, setTheme] = useState('light');
  const [user, setUser] = useState(null);

  return (
    <ThemeContext.Provider value={theme}>
      <UserContext.Provider value={user}>
        <Counter />
        <Form />
        <ThemedButton />
        <button onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}>
          Toggle Theme
        </button>
      </UserContext.Provider>
    </ThemeContext.Provider>
  );
}

export default App;
