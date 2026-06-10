# RESUME — сессия 2026-06-09 → 2026-06-11 (branch `feat/datalog`, ~36 коммитов, НЕ пушено)

Контекст для продолжения после компакции. Канонический длинный леджер: `rfdb-datalog-RESUME.md`
(история гейтов) + `resolve-datalog2-migration-synthesis.md` (волны миграции, ВСЕ верифицированные
числа). Этот файл — оперативная сводка.

## ГДЕ МЫ: цель пользователя и её статус

**Главный замысел (явно от пользователя): resolve-фаза и плагины должны СТАТЬ datalog2-паками.**
Достигнуто на сегодня:
- 4 таймаутящих .mjs-плагина заменены паками (60s timeout × 4 → секунды); выпилены из
  `.grafema/config.yaml` (остались type-inference, shape-tracker).
- **18 stdlib-паков** (`packages/rfdb-server/src/datalog2/stdlib/*.dl`), порядок = контракт в
  `STDLIB_PACKS` (stdlib.rs) и `STDLIB_RULE_PACKS` (orchestrator main.rs).
- **3 legacy js-шага РЕАЛЬНО выключены** (`GRAFEMA_SKIP_RESOLVE_STEPS=js-local-refs,
  same-file-calls,property-access` — env, не персистится; class-inheritance вернули в legacy до
  Wave 3 — после мержа main сам починил builtin-EXTENDS, оба продьюсера согласны).
- Дифференциалы: Wave 1 PASS (READS_FROM 98.5%, in-scope CALLS 99.4%); гейтед fresh-DB
  counts-проверки PASS (EXTENDS 14/14 и т.д.).

## СОСТОЯНИЕ ДЕРЕВА (на момент компакции)

- HEAD ≈ `docs(research): post-merge baseline...`; **merge origin/main (115 коммитов) ВЛИТ**
  (`fa76f1d1`), всё зелёное: **lib 1317/0 (впервые!), Gate A differential 10/10, orchestrator
  466/0**. Рабочее дерево чистое. НЕ пушено (запрет: никогда не пушить без явной команды).
- Граф `.grafema/graph.rfdb` свежий пост-мерж: **491 535 узлов / 1 037 299 рёбер** (рост +15% —
  main-анализатор эмитит макросы-как-CALL, unions, FFI). Полный analyze 962s.
- Бинарники свежие: rfdb-server + orchestrator (target/release) + js-analyzer/grafema-resolve
  (`~/.grafema/bin`, build-hash синкан).

## ГЛАВНЫЕ ЧИСЛА (хронология одной метрики: datalog/pack-фаза реанализа)

900s timeout (старт) → 38.6s (W5, 7 паков) → 223s (15 паков shadow) → **85.4s (W6)** →
**330s (пост-мерж, 18 паков на +15% графе с макро-CALL взрывом: rust_calls 16→68s,
js_builtins 71s)**. Цель ≤60s на НОВОМ бейзлайне снова открыта — рычаги ниже.

## СЛЕДУЮЩИЕ ШАГИ (по порядку)

1. **Макро-фильтрация в name-resolution паках** — main-анализатор тегирует macro=true; решить,
   входят ли println!-класс инвокации в CALLS-резолюцию (вероятно нет) — вернёт большую часть
   330s→.
2. **Wave 3a (path/string-кит builtins: path_resolve, last_segment и т.п.) → Wave 3b (модульные
   ядра import-resolution js+rust)** → гейт import-resolution/builtins шагов → js/rust-резолверы
   уходят целиком → финальный дифференциал.
3. **W9** (edges_by_type оракул в Stats; BindRow/Vec<Value> представление — ЗАМЕРЕННЫЙ hot-spot
   join_derived проб; attr distinct-scan кап) и **W8** (disconnect-cancel — кусался ~5 раз за
   сессию: запросы переживают смерть клиента и жуют CPU 15+ мин; persistent clear; durable
   D2-pin; потом флип RFDB_DATALOG_V2 default).
4. Wave 4 (runtime-globals facts-паки), haskell/beam-резолверы, type-inference/shape-tracker
   (учесть: main уже частично переписал shape-tracker на Datalog v1 — `ec109dba`).
5. Апстримнуть в main: фикс 2 скобок rust_analyzer.rs (main НЕ КОМПИЛИРУЕТСЯ — наш коммит
   "fix(orchestrator): repair two missing braces...", crate не гейтится их CI).

## ПРОЦЕСС-ПРАВИЛА ЭТОЙ РАБОТЫ (выстраданы, соблюдать)

- **Конвейер**: Workflow { имплементер(ы) → адверсариальный ревьюер со списком конкретных ловушек
  → независимый тест-раннер → fix-раунд }. Поймал 5+ инвариантных багов до прода. Скрипты воркфлоу
  в `~/.claude/projects/.../workflows/scripts/` — переиспользовать шаблон.
- **Диета конвейера** (после жалобы на рост длительности фаз): полнографовый analyze НЕ в
  агентских циклах (фикстуры + dogfood-scale planning-гейт `stdlib_packs_plan_under_dogfood_scale_stats`);
  Gate A один раз у тест-раннера; волны резать мельче. Прекомпиляция бинарников греет только
  первую сборку агента — их собственные изменения они пересобирают сами.
- **Малые фикстуры** для итераций движка (0.04s юниты); полный граф = ОДИН финальный замер.
- **Коммитить** после каждой верифицированной волны (серия одобрена пользователем); НЕ пушить.
- Каждый пак: numbered DELTA-комменты в .dl-хедере + fixture-тесты, пиннящие дельты; additive
  для шарёных типов (CALLS/READS_FROM/EXTENDS/ROUTES_TO...), exclusive только для pack-owned
  (SHAPE_VIOLATION) и provenance-scoped для узлов.
- mts/cts: 8-extension гейты в паках; cross-language утечка имён-индексов — стандартная проверка
  ревьюера (был must-fix).

## ГОТЧИ ОКРУЖЕНИЯ (стоили времени)

- **Сон ноута починен** (`pmset -c sleep 0`, `-b sleep 15`) — раньше `sleep 1` убивал всё;
  длинные detached-прогоны всё равно через `caffeinate -i`.
- **Stale-binary guard**: после ЛЮБОГО изменения исходников нативных пакетов (включая merge!) —
  `scripts/build-native.sh packages/<pkg> cabal install --install-method=copy
  --overwrite-policy=always` (+ `source ~/.ghcup/env`).
- **Рецепт analyze** (из корня репо!): pkill сокет-сервера, `rm -f .grafema/rfdb.sock`,
  `rm -rf .grafema/graph.rfdb .grafema/gen-tracker.json` для fresh-DB (`--clear` — ПЛАЦЕБО,
  gaps.md), env `RFDB_DATALOG_V2=on GRAFEMA_ORCHESTRATOR=... GRAFEMA_RFDB_SERVER=...`,
  `nohup caffeinate -i node packages/cli/dist/cli.js analyze . --log-level info &`. ~10-16 мин.
- **Относительные пути**: cwd шелла сбрасывается/мигрирует — analyze и rm только с абсолютными
  или из проверенного корня (один раз чуть не потеряли граф, спасла та же ошибка).
- Серверы после analyze бывают заняты хвостами умерших клиентов (W8-баг) — перед live-запросами
  перезапустить; `getAllEdges` на больших графах НЕ работает (v3 sid-резолюция + парсинг кадра
  > 900s) — только sampled `queryEdges`-пробы или countEdgesByType.
- MVCC: тесты-фикстуры обязаны `flush()` после add_nodes/add_edges (visibility=publish) — 56
  main-тестов чинились этим после мержа.
- Pre-commit hook гоняет JS-тесты — коммиты идут долго, это норм.

## ОТКРЫТЫЕ ХВОСТЫ (не потерять)

- `js_this_method_calls` даёт 1-0 рёбер — аномалия не разобрана (B1-арка same_file перекрывает?).
- Gate A однажды флейкнул первым запуском после холодного кэша (повтор чистый) — не разобрано.
- W4-advisory список в gaps.md (7 пунктов: auto-flush под давлением, never-rewrite staleness...).
- 18 protocol_tests в bin (find_by_attr/streaming) падали pre-existing ДО мержа — проверить,
  чинит ли их main-набор (после мержа bin-сьют не перегонялся!).
- Дубликация chain-prelude в 3 паках (нужен pack-include механизм).
- `_bench/rfdb-mvcc/*`, `_ai/research/rfdb-mvcc-*` и пр. untracked — ЧУЖИЕ артефакты, не трогать.
