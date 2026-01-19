/**
 * Complete DOM events coverage
 *
 * Tests: All React synthetic events
 */
import React, { useState, useRef } from 'react';

function EventShowcase() {
  const [log, setLog] = useState([]);
  const dragDataRef = useRef(null);

  const addLog = (event) => {
    setLog(l => [...l.slice(-20), `${Date.now()}: ${event}`]);
  };

  return (
    <div>
      {/* ============ MOUSE EVENTS ============ */}
      <section>
        <h3>Mouse Events</h3>
        <div
          onClick={(e) => addLog(`click at ${e.clientX},${e.clientY}`)}
          onDoubleClick={() => addLog('doubleClick')}
          onContextMenu={(e) => { e.preventDefault(); addLog('contextMenu'); }}
          onMouseDown={(e) => addLog(`mouseDown button=${e.button}`)}
          onMouseUp={() => addLog('mouseUp')}
          onMouseEnter={() => addLog('mouseEnter')}
          onMouseLeave={() => addLog('mouseLeave')}
          onMouseMove={(e) => {/* too noisy */}}
          onMouseOver={() => addLog('mouseOver')}
          onMouseOut={() => addLog('mouseOut')}
          style={{ padding: 20, background: '#eee' }}
        >
          Mouse Target
        </div>
      </section>

      {/* ============ KEYBOARD EVENTS ============ */}
      <section>
        <h3>Keyboard Events</h3>
        <input
          onKeyDown={(e) => addLog(`keyDown: ${e.key} code=${e.code}`)}
          onKeyUp={(e) => addLog(`keyUp: ${e.key}`)}
          onKeyPress={(e) => addLog(`keyPress: ${e.key}`)}  // Deprecated but still used
          placeholder="Type here"
        />
      </section>

      {/* ============ FOCUS EVENTS ============ */}
      <section>
        <h3>Focus Events</h3>
        <input
          onFocus={(e) => addLog('focus')}
          onBlur={(e) => addLog('blur')}
          placeholder="Focus me"
        />
        {/* Capture phase */}
        <div onFocusCapture={() => addLog('focusCapture (parent)')}>
          <input placeholder="Focus capture test" />
        </div>
      </section>

      {/* ============ FORM EVENTS ============ */}
      <section>
        <h3>Form Events</h3>
        <form
          onSubmit={(e) => { e.preventDefault(); addLog('submit'); }}
          onReset={() => addLog('reset')}
        >
          <input
            onChange={(e) => addLog(`change: ${e.target.value}`)}
            onInput={(e) => addLog(`input: ${e.target.value}`)}
            onInvalid={() => addLog('invalid')}
            required
          />
          <select onChange={(e) => addLog(`select change: ${e.target.value}`)}>
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
          <button type="submit">Submit</button>
          <button type="reset">Reset</button>
        </form>
      </section>

      {/* ============ TOUCH EVENTS ============ */}
      <section>
        <h3>Touch Events</h3>
        <div
          onTouchStart={(e) => addLog(`touchStart touches=${e.touches.length}`)}
          onTouchMove={(e) => addLog('touchMove')}
          onTouchEnd={() => addLog('touchEnd')}
          onTouchCancel={() => addLog('touchCancel')}
          style={{ padding: 20, background: '#ddf' }}
        >
          Touch Target (mobile)
        </div>
      </section>

      {/* ============ DRAG & DROP EVENTS ============ */}
      <section>
        <h3>Drag & Drop Events</h3>
        <div
          draggable
          onDragStart={(e) => {
            dragDataRef.current = 'dragged data';
            e.dataTransfer.setData('text/plain', 'hello');
            addLog('dragStart');
          }}
          onDrag={() => {/* too noisy */}}
          onDragEnd={() => addLog('dragEnd')}
          style={{ padding: 10, background: '#fdd', cursor: 'move' }}
        >
          Drag me
        </div>
        <div
          onDragEnter={(e) => { e.preventDefault(); addLog('dragEnter'); }}
          onDragOver={(e) => { e.preventDefault(); }}
          onDragLeave={() => addLog('dragLeave')}
          onDrop={(e) => {
            e.preventDefault();
            const data = e.dataTransfer.getData('text/plain');
            addLog(`drop: ${data}`);
          }}
          style={{ padding: 20, background: '#dfd', marginTop: 10 }}
        >
          Drop here
        </div>
      </section>

      {/* ============ SCROLL / WHEEL EVENTS ============ */}
      <section>
        <h3>Scroll & Wheel Events</h3>
        <div
          onScroll={(e) => addLog(`scroll: ${e.target.scrollTop}`)}
          onWheel={(e) => addLog(`wheel: deltaY=${e.deltaY}`)}
          style={{ height: 100, overflow: 'auto' }}
        >
          <div style={{ height: 300 }}>Scroll me</div>
        </div>
      </section>

      {/* ============ CLIPBOARD EVENTS ============ */}
      <section>
        <h3>Clipboard Events</h3>
        <input
          onCopy={(e) => addLog('copy')}
          onCut={(e) => addLog('cut')}
          onPaste={(e) => addLog(`paste: ${e.clipboardData.getData('text')}`)}
          defaultValue="Copy/Cut/Paste me"
        />
      </section>

      {/* ============ COMPOSITION EVENTS (IME) ============ */}
      <section>
        <h3>Composition Events (IME)</h3>
        <input
          onCompositionStart={() => addLog('compositionStart')}
          onCompositionUpdate={(e) => addLog(`compositionUpdate: ${e.data}`)}
          onCompositionEnd={(e) => addLog(`compositionEnd: ${e.data}`)}
          placeholder="Type in Japanese/Chinese"
        />
      </section>

      {/* ============ MEDIA EVENTS ============ */}
      <section>
        <h3>Media Events</h3>
        <video
          onPlay={() => addLog('play')}
          onPause={() => addLog('pause')}
          onEnded={() => addLog('ended')}
          onTimeUpdate={(e) => {/* too noisy */}}
          onLoadedData={() => addLog('loadedData')}
          onLoadedMetadata={() => addLog('loadedMetadata')}
          onCanPlay={() => addLog('canPlay')}
          onWaiting={() => addLog('waiting')}
          onSeeking={() => addLog('seeking')}
          onSeeked={() => addLog('seeked')}
          onError={(e) => addLog('media error')}
          onVolumeChange={() => addLog('volumeChange')}
          controls
          style={{ width: 200 }}
        >
          <source src="video.mp4" type="video/mp4" />
        </video>
      </section>

      {/* ============ IMAGE EVENTS ============ */}
      <section>
        <h3>Image Events</h3>
        <img
          src="image.png"
          onLoad={() => addLog('img load')}
          onError={() => addLog('img error')}
          alt="test"
        />
      </section>

      {/* ============ ANIMATION EVENTS ============ */}
      <section>
        <h3>Animation Events</h3>
        <div
          onAnimationStart={() => addLog('animationStart')}
          onAnimationEnd={() => addLog('animationEnd')}
          onAnimationIteration={() => addLog('animationIteration')}
          className="animated-box"
        >
          Animated
        </div>
      </section>

      {/* ============ TRANSITION EVENTS ============ */}
      <section>
        <h3>Transition Events</h3>
        <div
          onTransitionEnd={() => addLog('transitionEnd')}
          className="transition-box"
        >
          Transition
        </div>
      </section>

      {/* ============ POINTER EVENTS ============ */}
      <section>
        <h3>Pointer Events</h3>
        <div
          onPointerDown={(e) => addLog(`pointerDown type=${e.pointerType}`)}
          onPointerUp={() => addLog('pointerUp')}
          onPointerMove={() => {/* too noisy */}}
          onPointerEnter={() => addLog('pointerEnter')}
          onPointerLeave={() => addLog('pointerLeave')}
          onPointerCancel={() => addLog('pointerCancel')}
          onGotPointerCapture={() => addLog('gotPointerCapture')}
          onLostPointerCapture={() => addLog('lostPointerCapture')}
          style={{ padding: 20, background: '#fdf' }}
        >
          Pointer Target
        </div>
      </section>

      {/* Event log */}
      <pre style={{ maxHeight: 200, overflow: 'auto', background: '#333', color: '#0f0', padding: 10 }}>
        {log.join('\n')}
      </pre>
    </div>
  );
}

export default EventShowcase;
