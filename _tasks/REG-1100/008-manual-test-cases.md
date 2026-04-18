# REG-1100 — Manual Test Cases

**Дата:** 2026-04-18
**Против:** `main` @ `fdb5e0ca` (PR #244 + PR #245 merged)
**Предусловия:**
- `pnpm install` свежий
- `pnpm --filter @grafema/gui build` ran (→ `packages/gui/dist/`)
- `./scripts/build-gui-for-rfdb.sh` ran (→ `packages/rfdb-server/target/release/rfdb-server` с embedded UI)

---

## TC-1 · rfdb-server serves /ui/ headless

**Что проверяем:** DAI-15 (dynamic port) + базовый /ui/ роутинг.

### Steps
1. В любой директории с `.grafema/` (или создай пустую: `mkdir /tmp/rfdb-smoke && cd /tmp/rfdb-smoke`) запусти:
   ```bash
   /Users/vadimr/grafema/packages/rfdb-server/target/release/rfdb-server \
     /tmp/rfdb-smoke/graph.rfdb --http-port 0 --data-dir /tmp/rfdb-smoke
   ```
2. Посмотри stderr — должна быть строка `[rfdb-server] HTTP listening on port NNNN` (порт OS-assigned, не 3335).
3. В новом терминале: `cat /tmp/rfdb-smoke/rfdb-http.port` — там число, тот же порт.
4. `curl -s http://localhost:NNNN/api/stats` → JSON `{nodeCount, edgeCount, ...}`.
5. `curl -s http://localhost:NNNN/ui/ | head -20` → HTML, есть `<div id="root">` и `web-*.js` ссылка.
6. `curl -s http://localhost:NNNN/ui/default | head -5` → HTML (SPA fallback — тот же web.html).
7. `curl -s http://localhost:NNNN/ui/mydb/unknown/path | head -5` → HTML (SPA fallback).
8. `Ctrl+C` на сервере → `cat /tmp/rfdb-smoke/rfdb-http.port` → **файл исчез** (SIGTERM cleanup).

### Ожидаемое
Всё в шаге 2-7 выше. Шаг 8 — файл удалён.

### Красный флаг
- `[rfdb-server] HTTP listening on port 0` (порт не был assigned) — проблема с local_addr lookup.
- Lockfile остался после Ctrl+C — signal handler не отработал.
- `/ui/` возвращает не HTML или 404 — rust-embed не нашёл bundle (проверь `ls packages/rfdb-server/target/release/build/rfdb-*/out/ui-dist/`).

---

## TC-2 · Браузер: 3D ↔ 2D переключение в `localhost:NNNN/ui/`

**Что проверяем:** HexAtlas mode toggle + rendering через rfdb-served bundle (полный цикл build→embed→serve→render).

### Steps
1. С запущенным `rfdb-server` (из TC-1 шаг 1), возьми порт из lockfile.
2. Открой `http://localhost:NNNN/ui/` в Chrome.
3. Карта грузится — видишь hex tiles (если был Analyze) **или** "waiting for graph stream" / empty canvas (если nodeCount=0 — тогда нужно сначала `grafema analyze` в рабочей директории).
4. Найди в правом-верхнем углу toggle `2D | 3D`. Активная кнопка подсвечена cyan.
5. Открой DevTools → Console. Введи: `debugScene.background.getHexString()` — запомни цвет (тёмный `0a0a12`).
6. Кликни `2D`. Ожидания:
   - Камера переключается сверху-вниз (ortho)
   - Фон светлеет до `#f4f4f4`
   - Тайлы становятся плоскими (нет elevation)
   - Flow edges (если видны) тонкие line, не tubes
   - `debugScene.background.getHexString()` → `f4f4f4`
7. Наведи мышь на любой тайл → появляется tooltip с именем / типом / region / file:line (если node.line).
8. Двойной клик на тайле → пин (ring outline в 2D, elevation в 3D). В Sidebar появляется запись в "Pins" секции.
9. Кликни `3D` → камера возвращается perspective, pin всё ещё виден (теперь как elevated tile с outline).
10. В Sidebar переключи любой flow preset (например "bridges") → edges появляются/исчезают.
11. В DevTools: `grafema.flyTo({nodeName: '<имя из tooltip шага 7>'})` → камера летит к узлу.

### Ожидаемое
Все 11 шагов работают. Переключение мода — плавное, без разрушения state (pins, flows, selection переживают).

### Красный флаг
- ModeToggle не отображается → проверь что `web.html` в `/ui/` собран из свежего dist
- Клик `2D` → ошибка в console про disposed/undefined refs → C-Canvas-refactor регрессия
- `debugScene` undefined → DEV gate не сработал (мы в prod build, что ок) ИЛИ rendering не поднялся
- Tooltip без `file:line` row (если node.line есть) → DAI-5 регрессия

---

## TC-3 · VS Code: `Grafema: Open Map` без предварительного Analyze

**Что проверяем:** DAI-17 (openMap auto-start) + DAI-15 (dynamic port в реальной workspace).

### Prep
1. Открой VS Code в **новой** grafema-workspace, где `.grafema/` нет (или удали: `rm -rf .grafema`).
2. Установи локальную расширения:
   ```bash
   cd /Users/vadimr/grafema
   pnpm --filter grafema-explore build
   # В VS Code: Cmd+Shift+P → "Developer: Install Extension from Location" → /Users/vadimr/grafema/packages/vscode
   ```

### Steps
1. В VS Code Command Palette: `Grafema: Open Map`.
2. Ожидание (всё за **≤10 секунд**):
   - Сначала "Starting GUI server..." loader в webview panel
   - Потом loader сменяется на iframe с картой
   - ИЛИ: showWarningMessage "Start `Grafema: Analyze` first..." (если реально никакого workspace state нет и startServer не смог подняться)
3. Если карта загрузилась: см. TC-2 шаги 4-11 для behavioral checks внутри webview.
4. Если warning: запусти `Grafema: Analyze` явно, дождись завершения, ещё раз `Grafema: Open Map` — теперь должно сработать.

### Красный флаг
- Loader висит 60 секунд → DAI-17 регрессия (auto-start не триггерит startServer)
- Iframe показывает `hex-topology.html` 404 → старый mapPanel каким-то образом остался
- CSP ошибка в DevTools webview → CSP meta не применён / не разрешает frame-src http://localhost

---

## TC-4 · `grafema.databaseName` setting (DAI-16)

### Steps
1. В VS Code: Settings → Search `grafema.databaseName` → должен быть string default `"default"`.
2. Измени на `"myproj"`.
3. Если Map panel открыта — она должна **автоматически** перезагрузить iframe (URL меняется с `/ui/default` на `/ui/myproj`).
4. В DevTools webview → Network tab → iframe URL `http://localhost:NNNN/ui/myproj`.
5. rfdb-server лоигрует запрос на `/ui/myproj` (если multi-db не настроен — вернёт web.html SPA fallback, карта может показать "unknown db" или пустоту — это ок, просто проверяем что URL меняется).

### Красный флаг
- После смены setting панель не перезагружается → `onDidChangeConfiguration` hook не сработал
- URL остаётся `/ui/default` → databaseName не прочитался из config

---

## TC-5 · Port conflict resilience (DAI-15)

**Что проверяем:** что два grafema-workspace могут сосуществовать на одной машине.

### Steps
1. Запусти rfdb-server на фиксированном 3335: `rfdb-server /tmp/a/graph.rfdb --http-port 3335 --data-dir /tmp/a` (в фоне).
2. В VS Code открой **другую** workspace и запусти `Grafema: Open Map`.
3. Ожидание: вторая workspace подтягивает rfdb-server с `--http-port 0` → OS даёт другой свободный порт.
4. Проверь `cat <workspace2>/.grafema/rfdb-http.port` → должен быть **не 3335**.
5. Обе карты должны работать одновременно, каждая на своём порту.

### Красный флаг
- Вторая workspace падает с bind error → DAI-15 не работает
- Обе workspace слушают один порт → race condition

---

## TC-6 · Headless binary (без UI)

**Что проверяем:** Cargo feature `ui` opt-out для deployment.

### Steps
1. `cargo build -p rfdb-server --release --no-default-features` → производится бинарь `target/release/rfdb-server` БЕЗ embedded UI.
2. Размер binary должен быть **меньше** чем с UI (на ~300-500 KB).
3. Запусти headless: `./target/release/rfdb-server /tmp/rfdb-headless/graph.rfdb --http-port 0 --data-dir /tmp/rfdb-headless`.
4. `curl -s http://localhost:NNNN/api/stats` → 200 JSON.
5. `curl -s -o /dev/null -w "%{http_code}" http://localhost:NNNN/ui/` → **404** (нет UI роутинга).

### Красный флаг
- Default binary и no-default-features binary одного размера → feature gate не работает
- `/ui/` возвращает 200 в headless → роуты не под `#[cfg(feature = "ui")]`

---

## Priority для ручного прохода

1. **TC-2** (самое критичное — end-to-end render через полный pipeline)
2. **TC-3** (first-user-experience, DAI-17)
3. **TC-4** (короткий, проверяет DAI-16)
4. **TC-1** (smoke rfdb-server — быстрый)
5. **TC-5** (реалистичный multi-workspace)
6. **TC-6** (only if shipping headless)

Минимум для sign-off: TC-1, TC-2, TC-3.
