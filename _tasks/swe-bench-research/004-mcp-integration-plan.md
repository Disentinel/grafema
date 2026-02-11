# MCP Integration Plan: Grafema + mini-SWE-agent

## Ключевой инсайт

**Grafema как bash команда, не как MCP tool.**

Не нужно менять архитектуру mini-SWE-agent. Grafema CLI устанавливается в Docker контейнер, граф pre-computed при setup. Агент использует `grafema` как обычную bash команду (grep, find, cat, grafema).

## Архитектура

```
┌─────────────────────────────────────┐
│  mini-SWE-agent (без изменений)     │
│  - Отправляет bash commands         │
│  - Получает stdout/stderr           │
└──────────────┬──────────────────────┘
               │
               v
┌─────────────────────────────────────┐
│  Docker Container                    │
│  - стандартные утилиты (grep, cat)  │
│  - grafema CLI (НОВОЕ)              │
│  - .grafema/ граф (pre-computed)    │
└─────────────────────────────────────┘
```

## A/B Test Design

**Единственная переменная:**

| Аспект | Baseline | Experimental |
|--------|----------|--------------|
| Docker image | Standard | + Grafema CLI |
| System prompt | Standard | + Grafema instructions |
| Grafema graph | Нет | Pre-analyzed |
| Agent code | **Идентичен** | **Идентичен** |
| Model | **Идентичен** | **Идентичен** |

## Интеграция (3 точки изменений)

### 1. Dockerfile: добавить Grafema CLI
```dockerfile
# Расширение Docker image
RUN apt-get update && apt-get install -y nodejs npm
RUN npm install -g @grafema/cli
```

### 2. Container startup: pre-compute граф
```bash
# При создании контейнера для experimental condition
cd /testbed && grafema init && grafema analyze --quiet
```

### 3. System prompt: инструкции для агента
```
## Code Understanding Tools

You have access to `grafema`, a graph-based code analysis tool:

- `grafema query "function getUserById"` - Find function definitions
- `grafema find-calls functionName` - Find all callers
- `grafema trace-flow req.body --from api/handler.js` - Trace data flow
- `grafema query "http:route"` - Find HTTP routes

Use Grafema for navigation/understanding, standard tools for reading/editing.
```

## Почему этот подход лучше альтернатив

| Подход | Плюсы | Минусы |
|--------|-------|--------|
| **Bash command (выбран)** | Zero changes to agent, clean A/B | Need Grafema in Docker |
| MCP tool (external) | More realistic MCP usage | Changes agent architecture |
| Pre-computed context injection | Simplest | Not interactive, inflates prompt |
| Modified agent with dual tools | Most flexible | Hardest to implement, confounds |

## Grafema Queries для SWE-bench

### Самые полезные (по типу задачи)

**Bug fixing:**
- `grafema find-calls buggyFunction` — кто вызывает, impact analysis
- `grafema query "function buggyFunction"` — найти определение
- `grafema trace-flow variable --from file.js` — data flow

**Cross-module issues:**
- `grafema query "imports file.js"` — кто импортирует файл
- `grafema query "depends-on module"` — зависимости модуля

**API/route issues:**
- `grafema query "http:route"` — все HTTP routes
- `grafema query "http:handler"` — все обработчики

## Метрики

1. **Resolve rate** — % решённых задач
2. **Token efficiency** — токены на задачу
3. **Steps to solution** — количество bash commands
4. **Grafema adoption** — % задач где агент использовал grafema
5. **Query diversity** — сколько разных типов запросов

## Статистика

- 43 JS/TS задачи из SWE-bench Multilingual
- При delta 15%: p<0.05 с N=43 (Fisher's exact test)
- При delta 10%: нужно ~100 задач (Multi-SWE-bench)

## Риски

| Риск | Митигация |
|------|-----------|
| Grafema analyze fails на репо | Wrapper с fallback, логирование |
| Агент игнорирует grafema | Pilot test с разными prompt вариантами |
| Query latency | Timeout 30s, pre-computed graph |
| Docker image слишком большой | Multi-stage build |

## Timeline

| Шаг | Срок |
|-----|------|
| Docker image + wrapper | 1 день |
| Prompt engineering + pilot (5 задач) | 1-2 дня |
| Baseline run (43 задачи) | 1 день |
| Experimental run (43 задачи) | 1 день |
| Анализ результатов | 1 день |
| **Итого** | **~5-6 дней** |
