# Phase 0 Report: Infrastructure Research

## Сводка

Изучены три компонента: два бенчмарка (Multi-SWE-bench, SWE-PolyBench) и agent scaffolding.

---

## 1. Multi-SWE-bench (рекомендован как основной)

**Repo:** https://github.com/multi-swe-bench/multi-swe-bench
**Dataset:** https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench

### Setup
```bash
git clone git@github.com:multi-swe-bench/multi-swe-bench.git
cd multi-swe-bench
make install
bash scripts/download_images.sh scripts/images_mini.txt  # pre-download Docker images
```

### Требования
- **Storage:** 120GB минимум
- **RAM:** 16GB (рекомендуется 128GB для параллелизма)
- **CPU:** 8 cores (рекомендуется 32)
- **Platform:** Linux, macOS, Windows

### Dataset format
Каждый instance содержит:
- `instance_id` — уникальный ID (org__repo_PR-number)
- `body` — описание PR/issue
- `resolved_issues` — связанные issues
- `fix_patch` — эталонный патч
- `test_patch` — изменения тестов
- `f2p_tests` — fail-to-pass тесты (должны пройти после фикса)
- `p2p_tests` — pass-to-pass тесты (не должны сломаться)

### JS/TS repos (580 задач)
| Repo | Задач | Язык |
|------|-------|------|
| sveltejs/svelte | 272 | JS |
| mui/material-ui | 174 | TS |
| iamkun/dayjs | 56 | JS |
| vuejs/core | 48 | TS |
| anuraghazra/github-readme-stats | 19 | JS |
| expressjs/express | 4 | JS |
| axios/axios | 4 | JS |
| darkreader/darkreader | 2 | TS |
| Kong/insomnia | 1 | JS |

### Evaluation flow
```bash
# Config file (JSON)
{
  "mode": "evaluation",
  "patch_files": ["./patches/*.jsonl"],
  "dataset_files": ["./dataset.jsonl"],
  "max_workers": 8,
  "output_dir": "./results"
}

# Run
python -m multi_swe_bench.harness.run_evaluation --config config.json

# Run single task
python -m multi_swe_bench.harness.run_evaluation \
    --config config.json \
    --instance_ids sveltejs__svelte_PR-1234
```

### Patch submission format (JSONL)
```jsonl
{"org": "sveltejs", "repo": "svelte", "number": 1234, "fix_patch": "diff --git a/..."}
```

### Timing
- ~8 сек/задача (32 cores, 128GB RAM, optimized)
- ~2-5 мин/задача (стандартная конфигурация)
- 50 задач ≈ 10 мин — 4 часа

### Варианты dataset
- **Full:** 1,632 задач
- **Mini:** 400 задач (cost-optimized)
- **Flash:** 300 задач (rapid testing)

---

## 2. SWE-PolyBench (альтернативный)

**Repo:** https://github.com/amazon-science/SWE-PolyBench

### Ключевые отличия от Multi-SWE-bench
| Аспект | Multi-SWE-bench | SWE-PolyBench |
|--------|-----------------|---------------|
| Всего задач | 1,632 | 2,110 |
| JS/TS задач | 580 | 1,746 (82.7%) |
| Языков | 7 | 4 |
| Курация | 68 экспертов | Автоматическая |
| Storage | 120GB | **1.2TB** |
| Eval time (500) | ~1-2 часа | **7-8 часов** |
| Leaderboard | Есть | Нет |
| CST metrics | Нет | **Есть** (node-level) |

### Преимущества
- **Больше JS/TS задач** (1,746 vs 580)
- **CST node-level метрики** — алайнятся с Grafema graph analysis
- **Не пересекается с SWE-bench** (разные репо)

### Недостатки
- **1.2TB storage** — серьёзный барьер
- **7-8 часов** на PB500 — долгий feedback loop
- **Нет leaderboard** — сложнее сравнивать с published results
- **Имена репо не задокументированы** — нужно скачать dataset

### Вердикт
Использовать как **Phase 4 scale-up**, не для пилота. Multi-SWE-bench проще начать.

---

## 3. Agent Scaffolding

### Рекомендация: mini-SWE-agent

**Repo:** https://github.com/SWE-agent/mini-swe-agent
**Docs:** https://mini-swe-agent.com/latest/

- **100 строк Python** — минимальный, контролируемый baseline
- **Bash-only** — не использует LLM tool-calling API, просто subprocess.run
- **74%+ на SWE-bench Verified** — state-of-the-art performance
- **Model-agnostic** — работает с Claude, GPT-4, etc.

### Core loop
```python
while not done:
    response = llm.query(messages)
    action = parse_bash_command(response)
    result = subprocess.run(action)
    messages.append(result)
```

### MCP интеграция
- Расширить agent для распознавания `grafema` commands
- Route к MCP серверу когда detected
- Иначе — bash как обычно
- Чистый A/B test: тот же агент, единственная переменная — наличие graph tools

### Стоимость
| Сценарий | Стоимость |
|----------|-----------|
| 1 задача (avg) | $0.30-$1.00 |
| 50 задач (pilot) | $15-$50 |
| 500 задач (full) | $150-$500 |
| С Batch API (50% off) | $75-$250 |

---

## 4. Решения и Next Steps

### Выбор стека
- **Бенчмарк:** Multi-SWE-bench (mini, 400 задач → filter JS/TS → ~100 задач)
- **Agent:** mini-SWE-agent + Claude API
- **Экспериментальная переменная:** Grafema MCP (on/off)
- **Метрики:** resolve rate, steps, tokens, localization accuracy

### Immediate next steps (Phase 0 продолжение)

1. **Клонировать Multi-SWE-bench** — изучить структуру кода, dataset format
2. **Скачать dataset** — Multi-SWE-bench mini с HuggingFace
3. **Отфильтровать JS/TS задачи** — составить pilot subset из 50 задач
4. **Клонировать mini-SWE-agent** — изучить код, протестировать на 1 задаче
5. **Проверить Grafema на target repos** — запустить `grafema analyze` на svelte, MUI, vue
6. **Определить MCP query set** — какие Grafema queries давать агенту

### Блокеры
- [ ] Нужен Docker (проверить установлен ли, сколько storage доступно)
- [ ] Нужен Claude API key для mini-SWE-agent
- [ ] Grafema может не полностью поддерживать target repos (svelte = compiler, MUI = TSX)

### Timeline
| Шаг | Срок | Зависимости |
|-----|------|-------------|
| Clone + setup Multi-SWE-bench | 1 день | Docker |
| Download + filter dataset | 1 день | HuggingFace |
| Setup mini-SWE-agent | 1 день | Claude API |
| Test single task end-to-end | 1 день | Всё выше |
| Run Grafema on target repos | 2-3 дня | — |
| Define MCP query set | 1-2 дня | Grafema analysis |
| **Phase 0 done** | **~1 неделя** | |
