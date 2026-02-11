# SWE-bench Benchmark Runbook

Полная методология A/B тестирования Grafema на SWE-bench.
Используется для измерения влияния graph context на качество AI-агента.

## Гипотеза

> AI-агент с graph context (Grafema) решает больше задач, тратит меньше токенов
> и делает меньше шагов, чем тот же агент без graph context.

## Инфраструктура

### Компоненты

| Компонент | Версия | Расположение |
|-----------|--------|-------------|
| mini-SWE-agent | 2.0.0a3 | `/Users/vadimr/swe-bench-research/mini-swe-agent/` |
| swebench | 4.1.0 | установлен в venv mini-SWE-agent |
| Python | 3.12 (brew) | venv: `mini-swe-agent/.venv/` |
| Docker | 28.x | Docker Desktop |
| API key | `.env` | `~/Library/Application Support/mini-swe-agent/.env` |
| Budget config | yaml | `/Users/vadimr/swe-bench-research/config/swebench-research.yaml` |

### Активация окружения

```bash
cd /Users/vadimr/swe-bench-research
source mini-swe-agent/.venv/bin/activate
```

### Budget config (`config/swebench-research.yaml`)

```yaml
agent:
  step_limit: 75
  cost_limit: 3.0
model:
  model_name: "anthropic/claude-sonnet-4-5-20250929"
  model_kwargs:
    drop_params: true
    temperature: 0.0
```

## Dataset

**SWE-bench Multilingual** — 43 JS/TS задачи из 300.

| Repo | Tasks |
|------|-------|
| preactjs/preact | 17 |
| axios/axios | 6 |
| babel/babel | 5 |
| facebook/docusaurus | 5 |
| vuejs/core | 5 |
| mrdoob/three.js | 3 |
| immutable-js/immutable-js | 2 |

Доступен через HuggingFace: `swe-bench/SWE-Bench_Multilingual`

## Эксперимент: 4 условия

| Condition | Model | Grafema | Цель |
|-----------|-------|---------|------|
| A | Sonnet 4.5 | No | Baseline (сильная модель) |
| B | Sonnet 4.5 | Yes | Grafema boost на сильной модели |
| C | Haiku 4.5 | No | Baseline (дешёвая модель) |
| D | Haiku 4.5 | Yes | Grafema boost на дешёвой модели |

Ожидаемая стоимость: 43 задачи x 4 условия x ~$0.50 avg = **~$86**

## Команды

### 1. Запуск агента (baseline, все 43 JS/TS задачи)

```bash
cd /Users/vadimr/swe-bench-research && source mini-swe-agent/.venv/bin/activate

# Фильтр для JS/TS задач
MSWEA_SILENT_STARTUP=1 python -m minisweagent.run.benchmarks.swebench \
    --subset multilingual --split test \
    --filter "^(axios|preact|babel|docusaurus|vuejs|three|immutable)" \
    -c mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml \
    -c config/swebench-research.yaml \
    -o results/baseline \
    -m "anthropic/claude-sonnet-4-5-20250929"
```

### 2. Одна задача (для теста)

```bash
MSWEA_SILENT_STARTUP=1 python -m minisweagent.run.benchmarks.swebench \
    --subset multilingual --split test \
    --filter "axios__axios" --slice "0:1" \
    -c mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml \
    -c config/swebench-research.yaml \
    -o results/baseline \
    -m "anthropic/claude-sonnet-4-5-20250929"
```

### 3. Конвертация preds.json → JSONL (для evaluation)

```python
import json
with open('results/baseline/preds.json') as f:
    data = json.load(f)
with open('results/baseline/preds.jsonl', 'w') as f:
    for instance_id, pred in data.items():
        f.write(json.dumps(pred) + '\n')
```

### 4. Evaluation (проверка патчей)

```bash
python -m swebench.harness.run_evaluation \
    --dataset_name swe-bench/SWE-Bench_Multilingual \
    --predictions_path results/baseline/preds.jsonl \
    --max_workers 1 \
    --run_id baseline_sonnet
```

### 5. Мониторинг прогресса

```bash
# Rich.Live перехватывает stdout — смотреть лог:
tail -f results/baseline/minisweagent.log

# Docker контейнеры:
docker ps --format '{{.Names}} {{.Status}}' | grep minisweagent

# Процесс жив?
ps aux | grep minisweagent | grep -v grep
```

## Gotchas (подводные камни)

### Пропуск задач
mini-SWE-agent пропускает задачи на основании `preds.json`, НЕ trajectory файлов.
Для перезапуска: удалить `preds.json` или использовать `--redo-existing`.

### Кэширование
Удаляй и `preds.json` И директорию результата:
```bash
rm results/baseline/preds.json
rm -rf results/baseline/axios__axios-4731/
```

### step_limit
50 шагов — недостаточно. Агент тратит ~49 шагов и не успевает сделать `git diff`.
75 шагов — работает, агент использует ~49 шагов при стоимости ~$0.51.

### JSONL формат
`preds.json` (dict) нужно конвертировать в JSONL для swebench evaluation.
mini-SWE-agent сохраняет dict, swebench ожидает JSONL.

### API key
Загружается из `~/Library/Application Support/mini-swe-agent/.env` через `dotenv.load_dotenv()`.
Не из shell env, не из .zshrc.

## Grafema Gap Analysis (текущее состояние)

### Подтверждённые gaps

| Issue | Проблема | Статус |
|-------|----------|--------|
| REG-393 | Directory index resolution (`require('./dir')` → EISDIR error) | В работе |
| REG-395 | `grafema grep` — text search с graph context | Backlog |

### Закрытые (false positive)

| Issue | Проблема | Почему ложный |
|-------|----------|---------------|
| ~~REG-394~~ | Conditional requires | `node-source-walk` обходит все ноды AST |

### Методика проверки coverage

```bash
# Клонировать repo на base_commit
git clone https://github.com/axios/axios.git /tmp/axios-test
cd /tmp/axios-test && git checkout <base_commit>
npm install

# Анализ Grafema
grafema analyze --auto-start

# Проверка coverage
grafema coverage

# Debug: найти реальные ошибки
grafema analyze --auto-start --log-level debug 2>&1 | grep -E "(ERROR|WARN|Parse error|EISDIR)"
```

### Правило: Debug log BEFORE diagnosis

При неожиданном поведении Grafema:
1. `grafema analyze --log-level debug` ПЕРВЫМ ДЕЛОМ
2. Найти ФАКТИЧЕСКУЮ ошибку в логах
3. Один симптом → одна причина → проверить что объясняет всё
4. НЕ заводить несколько багов без независимого подтверждения

## Метрики

| Метрика | Что измеряет | Как считать |
|---------|-------------|-------------|
| Resolve rate | % решённых задач | `resolved / submitted` из eval report |
| Cost per task | Стоимость одной задачи | `instance_cost` из trajectory |
| Steps | Количество bash команд | `api_calls` из trajectory |
| Grafema adoption | Использовал ли агент grafema | grep trajectory на `grafema` commands |
| Navigation ratio | Доля навигационных шагов | Ручной анализ trajectory |

## Результаты

### Pilot (2026-02-09): axios__axios-4731

| Metric | Value |
|--------|-------|
| Model | Sonnet 4.5 |
| Steps | 49 / 75 |
| Cost | $0.51 |
| Exit status | Submitted |
| Resolved | Yes (1/1 = 100%) |
| Navigation steps | ~30 / 49 (61%) |
| Fix/test steps | ~19 / 49 (39%) |

## Файловая структура

```
/Users/vadimr/swe-bench-research/
├── mini-swe-agent/           # Agent framework
│   ├── .venv/                # Python 3.12 venv
│   └── src/minisweagent/     # Source code
├── multi-swe-bench/          # Alternative dataset (580 JS/TS tasks)
├── config/
│   └── swebench-research.yaml  # Budget config
└── results/
    ├── baseline/             # Condition A: Sonnet, no Grafema
    │   ├── preds.json        # Predictions (dict format)
    │   ├── preds.jsonl       # Predictions (JSONL for eval)
    │   ├── minisweagent.log  # Agent log
    │   └── <instance_id>/    # Per-task trajectories
    ├── grafema/              # Condition B: Sonnet + Grafema
    ├── haiku-baseline/       # Condition C: Haiku, no Grafema
    └── haiku-grafema/        # Condition D: Haiku + Grafema
```

## Ссылки

- `_tasks/swe-bench-research/001-research-plan.md` — исходный план
- `_tasks/swe-bench-research/002-phase0-report.md` — research инфраструктуры
- `_tasks/swe-bench-research/003-phase0-setup-progress.md` — прогресс setup
- `_tasks/swe-bench-research/004-mcp-integration-plan.md` — как интегрировать Grafema
- `_tasks/swe-bench-research/005-grafema-gap-analysis.md` — gap analysis + post-mortem REG-394
