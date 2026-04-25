# CATCHES_FROM Edge Specification

## Decision

**CATCHES_FROM остаётся в scope REG-311.**

Источники для CATCHES_FROM: **всё что может бросить исключение** внутри try блока.

---

## Семантика

```
CATCH_BLOCK.parameter --CATCHES_FROM--> [источники исключений в TRY_BLOCK]
```

**Источники исключений:**

1. **Awaited calls** (async rejections):
   ```javascript
   try {
     await fetchData();  // CATCHES_FROM -> CALL[fetchData]
   } catch (e) { }
   ```

2. **Synchronous throws**:
   ```javascript
   try {
     throw new ValidationError();  // CATCHES_FROM -> THROW_STATEMENT
   } catch (e) { }
   ```

3. **Regular calls** (sync functions that can throw):
   ```javascript
   try {
     JSON.parse(data);  // CATCHES_FROM -> CALL[JSON.parse]
   } catch (e) { }
   ```

4. **New expressions** (constructors can throw):
   ```javascript
   try {
     new SomeClass();  // CATCHES_FROM -> CONSTRUCTOR_CALL
   } catch (e) { }
   ```

---

## Nested Try/Catch

```javascript
try {
  try {
    await inner();  // ErrorX
  } catch (e1) {
    throw e1;  // re-throw
  }
  await outer();  // ErrorY
} catch (e2) {
  // e2 catches: re-thrown e1 (from inner) + ErrorY
}
```

**Edges:**
```
CATCH_BLOCK[e1] --CATCHES_FROM--> CALL[inner]
CATCH_BLOCK[e2] --CATCHES_FROM--> THROW[e1]  (re-throw statement)
CATCH_BLOCK[e2] --CATCHES_FROM--> CALL[outer]
```

**Транзитивность:** Если нужно узнать что e2 может быть ErrorX, нужно:
1. Пройти по CATCHES_FROM от e2 к throw e1
2. Понять что e1 - catch параметр
3. Пройти по CATCHES_FROM от e1 к inner()
4. Пройти по REJECTS от inner к ErrorX

Это **query-time traversal**, не создаём транзитивные edges.

---

## Implementation

### Type Definition

```typescript
// Edge type
CATCHES_FROM: 'CATCHES_FROM'

// Metadata
interface CatchesFromMetadata {
  sourceType: 'awaited_call' | 'sync_call' | 'throw_statement' | 'constructor_call';
  sourceLine: number;
}
```

### Analysis Phase

В TryStatement handler:
1. Traverse try block
2. Collect all potential exception sources:
   - AwaitExpression containing CallExpression
   - CallExpression (any call can throw)
   - ThrowStatement
   - NewExpression
3. Store as `CatchesFromInfo[]`

### GraphBuilder Phase

```typescript
private bufferCatchesFromEdges(
  catchesFromInfos: CatchesFromInfo[],
  catchBlocks: CatchBlockInfo[]
): void {
  for (const info of catchesFromInfos) {
    this._bufferEdge({
      type: 'CATCHES_FROM',
      src: info.catchBlockId,  // CATCH_BLOCK node
      dst: info.sourceId,       // CALL, THROW, CONSTRUCTOR_CALL node
      metadata: {
        sourceType: info.sourceType,
        sourceLine: info.sourceLine
      }
    });
  }
}
```

---

## Test Cases

```typescript
describe('CATCHES_FROM edges (REG-311)', () => {
  it('should link catch param to awaited call', async () => {
    await setupTest(backend, {
      'index.js': `
async function test() {
  try {
    await riskyOp();
  } catch (e) {
    console.log(e);
  }
}
      `
    });

    const edges = await findEdgesByType(backend, 'CATCHES_FROM');
    expect(edges.length).toBe(1);
    expect(edges[0].metadata.sourceType).toBe('awaited_call');
  });

  it('should link catch param to sync throw', async () => {
    await setupTest(backend, {
      'index.js': `
function test() {
  try {
    throw new Error('fail');
  } catch (e) {
    console.log(e);
  }
}
      `
    });

    const edges = await findEdgesByType(backend, 'CATCHES_FROM');
    expect(edges.length).toBe(1);
    expect(edges[0].metadata.sourceType).toBe('throw_statement');
  });

  it('should link catch param to multiple sources', async () => {
    await setupTest(backend, {
      'index.js': `
async function test() {
  try {
    await a();
    throw new Error();
    await b();
  } catch (e) {
    console.log(e);
  }
}
      `
    });

    const edges = await findEdgesByType(backend, 'CATCHES_FROM');
    expect(edges.length).toBe(3);  // a(), throw, b()
  });
});
```

---

## Complexity

- Detection: O(statements in try block) per try/catch
- Edge creation: O(sources per catch block)
- Total: O(try_blocks * avg_statements) - линейно от размера кода

---

## Timeline Impact

CATCHES_FROM: **+1.5 days** (уже учтено в 11-13 days estimate)
