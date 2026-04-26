# Pilot: Haiku 4.5 + Grafema on axios__axios-4731

## Результат

| Metric | Sonnet baseline | Haiku + Grafema |
|--------|----------------|-----------------|
| Model | Sonnet 4.5 | Haiku 4.5 |
| Steps | 49 / 75 | 45 / 75 |
| Cost | ~$0.51 | ~$0.05 (est) |
| Exit | Submitted | Submitted |
| **Eval** | **PASS** | **FAIL** |
| Grafema usage | N/A | 1x `grafema overview` |

## Patches

### Sonnet (PASS)
```diff
if (config.maxBodyLength > -1) {
  options.maxBodyLength = config.maxBodyLength;
+} else if (config.maxBodyLength === -1) {
+  options.maxBodyLength = Infinity;
}
```

### Haiku (FAIL)
```diff
if (config.maxBodyLength > -1) {
  options.maxBodyLength = config.maxBodyLength;
+} else if (transport === httpsFollow || transport === httpFollow) {
+  // For follow-redirects, set maxBodyLength to Infinity when config.maxBodyLength is -1
+  // to maintain consistency with the default behavior (unlimited)
+  options.maxBodyLength = Infinity;
}
```

## Анализ

### Почему Haiku не прошёл

Haiku правильно идентифицировал баг (maxBodyLength: -1 не передаётся follow-redirects), но сгенерировал **слишком специфичный фикс** — проверка `transport === httpsFollow || transport === httpFollow` вместо простого `config.maxBodyLength === -1`. Haiku добавил лишнее условие, привязанное к конкретному транспорту, тогда как тесты ожидают безусловную обработку `-1`.

Это типичная проблема моделей меньшего размера — они "переинженерят" решение, добавляя ненужную специфику.

### Почему Grafema не помогла

Haiku использовал Grafema только 1 раз (`grafema overview`) на шаге 2, потом переключился на стандартные инструменты (find, grep, cat). Причины:

1. **System prompt не достаточно directive** — Grafema упомянута как опция, а не как первый шаг
2. **Задача простая для навигации** — axios маленький проект, grep справляется
3. **Grafema query для property access не работает** — `query "maxBodyLength"` ничего не найдёт (property access не индексируется, REG-395)
4. **Haiku не знает что спрашивать** — без опыта работы с Grafema, модель не знает какие запросы полезны

### Workflow Haiku (45 steps)

1. `ls -la` → структура проекта
2. `grafema overview` → 39 modules, 184 functions
3. `find *.js | grep http` → нашёл adapter
4. `cat lib/adapters/http.js | head -100` → начал читать
5. `grep -n "maxBodyLength" lib/adapters/http.js` → нашёл строки
6-10. Читал файлы (defaults, mergeConfig, follow-redirects)
11-20. Создавал reproduction script, тестировал
21-35. Правил код, проверял
36-45. Edge cases, submission

## Выводы для эксперимента

### Что нужно улучшить

1. **Grafema adoption** — модель должна активнее использовать Grafema
   - Более directive system prompt ("ALWAYS start with grafema")
   - Примеры конкретных запросов в промпте
   - Показать output `grafema overview` прямо в промпте (zero-shot context)

2. **Grafema query coverage** — REG-395 (property access) критичен для SWE-bench
   - `grafema query "maxBodyLength"` должен находить property accesses
   - Без этого агент быстро откатывается к grep

3. **Тестирование на разных задачах** — одна задача недостаточна
   - axios-4731 слишком простая для Grafema
   - Нужна задача где навигация реально сложная (babel, vuejs/core)

4. **Haiku baseline без Grafema** — нужно для fair comparison
   - Condition C ещё не прогнан
   - Может Haiku и без Grafema решит/не решит так же

### Техническая инфраструктура

Docker интеграция работает:
- npm install -g из .tgz (50s)
- rfdb-server binary копируется в ~/.local/bin
- grafema analyze (30-40s)
- Итого startup: ~90s в Docker (300s timeout хватает)

### Следующие шаги

1. [ ] Прогнать Haiku baseline (без Grafema) на axios-4731
2. [ ] Улучшить system prompt для Grafema
3. [ ] Попробовать на другой задаче (preact или babel)
4. [ ] Рассмотреть pre-injection Grafema output в промпт

## Файлы

- Config: `/Users/vadimr/swe-bench-research/config/haiku-grafema.yaml`
- Results: `/Users/vadimr/swe-bench-research/results/haiku-grafema/`
- Trajectory: `results/haiku-grafema/axios__axios-4731/axios__axios-4731.traj.json`
- Eval: `anthropic__claude-haiku-4-5-20251001.haiku_grafema.json`
- Grafema dist: `/Users/vadimr/swe-bench-research/grafema-dist/` (6 .tgz packages)
