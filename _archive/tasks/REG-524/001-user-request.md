# REG-524: Demo среда: code-server + RFDB WebSocket + Grafema extension

## Source
Linear issue REG-524, triggered by user command "REG-524"

## Original Request (from Linear)

Поднять демо-среду для early access: пользователь переходит по ссылке и сразу попадает в VS Code с установленным Grafema extension и живым графом — без локальной установки.

### Компоненты
- **code-server** — VS Code в браузере, self-hosted
- **rfdb-server** с WebSocket транспортом (REG-523) — доступен из браузерного контекста через ws://
- **Grafema VS Code extension** — предустановлен через .vsix, настроен на WebSocket
- **Демо-проект** — реальная кодовая база с предварительно построенным графом

### Acceptance Criteria
- `docker run grafema/demo` поднимает полную среду за < 30 сек
- Пользователь видит граф демо-проекта без каких-либо настроек
- Playwright smoke test проходит в CI
- Задокументирован процесс обновления .vsix в демо-образе

### Dependencies
- REG-523 (WebSocket transport) — MERGED ✓

## MLA Config
Mini-MLA (Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim)
