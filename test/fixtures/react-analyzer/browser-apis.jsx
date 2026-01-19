/**
 * Browser APIs usage
 *
 * Tests: Detecting browser side effects
 * - localStorage/sessionStorage
 * - DOM manipulation
 * - History API
 * - Timers
 * - Clipboard API
 */
import React, { useState, useEffect, useRef } from 'react';

function BrowserFeatures() {
  const [theme, setTheme] = useState('light');
  const [path, setPath] = useState(window.location.pathname);
  const inputRef = useRef(null);

  // localStorage read/write
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved) setTheme(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', theme);
  }, [theme]);

  // sessionStorage
  useEffect(() => {
    const sessionData = sessionStorage.getItem('session');
    console.log('Session:', sessionData);
  }, []);

  // DOM manipulation (focus)
  function focusInput() {
    inputRef.current?.focus();
  }

  // DOM querySelector (anti-pattern in React but happens)
  function highlightAll() {
    document.querySelectorAll('.highlight').forEach(el => {
      el.style.backgroundColor = 'yellow';
    });
  }

  // History API
  function navigate(newPath) {
    window.history.pushState({}, '', newPath);
    setPath(newPath);
  }

  // Clipboard API
  async function copyToClipboard(text) {
    await navigator.clipboard.writeText(text);
  }

  // Timer
  function scheduleTask() {
    setTimeout(() => {
      console.log('Task executed');
    }, 1000);
  }

  // Scroll
  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Alert/Confirm (blocking!)
  function showAlert() {
    alert('Hello!');
    const confirmed = confirm('Continue?');
    if (confirmed) {
      console.log('Confirmed');
    }
  }

  return (
    <div>
      <input ref={inputRef} />
      <button onClick={focusInput}>Focus</button>
      <button onClick={() => navigate('/new-path')}>Navigate</button>
      <button onClick={() => copyToClipboard('copied!')}>Copy</button>
      <button onClick={scheduleTask}>Schedule</button>
      <button onClick={scrollToTop}>Scroll Top</button>
      <button onClick={showAlert}>Alert</button>
      <button onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}>
        Toggle Theme
      </button>
    </div>
  );
}

export default BrowserFeatures;
