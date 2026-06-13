# RESUME — сессии 2026-06-09 → 2026-06-12 (branch `feat/datalog`, ~47 коммитов, НЕ пушено)

**НЕЙМИНГ (с 0.4.0):** query engine (`datalog/`, wire datalogQuery, Gate A оракул) /
derive engine (`derive/`, бывш. datalog2: паки, @materialize, maintain). Capability
`datalogDerive`, env `RFDB_DERIVE_ENGINE` (=off — серверный debug-свитч, БЕЗ деривации вообще).

Канонический леджер: `resolve-datalog2-migration-synthesis.md` (ВСЕ верифицированные числа
по волнам) + `rfdb-datalog-RESUME.md` (история гейтов A-D, устарел после Wave 3+).

## ИТОГ: главный замысел ДОСТИГНУТ (задачи #10/#12 закрыты 2026-06-12)

**Resolve-фаза и плагины СТАЛИ datalog2-паками, и это ДЕФОЛТ:**
- **22 stdlib-пака**; js/rust legacy-шаги retired BY DEFAULT (`RETIRED_FIRST_PASS_STEPS` +
  `RETIRED_SECOND_PASS_STEPS` в orchestrator main.rs; capability-conditional для first-pass —
  на не-v2 сервере legacy продолжает работать; env GRAFEMA_SKIP_RESOLVE_STEPS аддитивен).
- **RFDB_DATALOG_V2 default = ON** (off-switch: `RFDB_DATALOG_V2=off`; Hello capability +
  legacy P3 fallback для старых серверов сохранены, роутер-тесты есть).
- **Дифференциалы exact**: import-resolution 679≡679 + RE_EXPORTS 9≡9; runtime-globals
  7,800≡7,800 (183 seNames); binding-hop 263→0; this-method-calls 432≡432 (set-identical,
  на свежем прогоне срез поглощает same_file_calls B1 — additive union); class-inheritance
  EXTENDS 14/14, INSTANCE_OF-армы legacy измерены = 0 на dogfood (97 INSTANCE_OF все от
  type-inference плагина; evidence dogfood-bound, см. doc у RETIRED_FIRST_PASS_STEPS).
- **Чистый прогон на дефолтах (2026-06-12, worktree)**: 502,509 узлов / 1,062,679 рёбер,
  все zero-legacy-stamp гейты = 0, acceptance probe `final12_acceptance_counts` PASS
  (GRAFEMA_FINAL12_COUNTS_DB=/tmp/final12.rfdb, проба в differential.rs).

## ЧИСЛА (хронология)

- **Pack-фаза**: 900s timeout → 330s (post-merge) → 176.6s (M+3a-c) → 81.3s (W9) →
  **56.2s warm-probe / ~74s на свежем analyze с записями** (W9-iter2+W4). Цель ≤60s взята
  на warm; на свежем прогоне каждый пак коммитит → partial cache evictions.
- **Полный analyze**: 962s → 634s → **505.3s** (чистые дефолты).
- Перф-механика: SharedIndexCaches (version+tombstone-Arc keyed), stats-кэш, edge_attr
  build-once индекс, derived full-key join, Wildcard-фикс probe-ключей, idle short-circuit.

## W8 (production-блокеры) — ЗАКРЫТ

disconnect-cancel (watcher poll+MSG_PEEK; CRITICAL: cancel в финальном леге выглядел как
конвергенция → write-back чуть не терял 1,726 рёбер — post-fixpoint final guard, falsified
тест); durable clear (618M→16K, рестарт=0 узлов, плацебо мёртв, gaps.md RESOLVED); durable
D2-pin (BLAKE3 sidecar, version+tombstone-hash ключ, riders-gate; рестарт 6.62s→0.04s).

## ОСТАВШИЕСЯ ЗАДАЧИ (порядок)

1. ✅ **#13 cleanup = Wave 6 DONE 2026-06-12** (uncommitted): fallback удалён ЦЕЛИКОМ по
   решению юзера (no users → minor 0.4.0 + Breaking Changes). Orchestrator fail-fast без
   datalogV2Materialize (analyze И resolve); retired-сеты растворены; P3 legacy DEPENDS_ON
   + lock удалены; pack-failure теперь РОНЯЕТ run (collect-then-fail, тест с fake-сервером);
   удалены 12 Haskell-модулей + оба Spec-хвоста (41 файл, +677/−5,014); js-daemon = только
   runtime-globals (RESOLVES_TO-арм, пака нет), rust-daemon = rust-cross-methods (dyn/self-field
   армы без пака) + rust-globals. Acceptance: свежий PURE-defaults analyze exit 0,
   496,522/1,051,686, 679≡679/star 9/EXTENDS 14/rg 7,805/все zero-stamp гейты = 0; дрейф
   объяснён (удалённый .hs-корпус; rust_calls без макросов — задекларированная Wave-M
   дивергенция). Леджер: Wave 6 секция в synthesis. Версии 0.3.29→0.4.0 (вкл. бинарные
   пины grafema/mcp/cli), НЕ опубликовано, НЕ закоммичено.
2. Advisory из ревью #12: (a) ~~second-pass capability-conditional~~ MOOT (Wave 6 удалила
   second pass); (b) ~~pack-failure coupling~~ ЗАКРЫТО Wave 6 (run fails);
   (c) 18 bin protocol_tests pre-existing (MVCC no-flush фикстуры) — триаж;
   (d) property-access evidence-class в доке (W6 aggregate, не set-diff).
3. **#7** tiered compaction; **#14** feature-detection енричеры → паки (пост-релиз);
   java/kotlin/go спек-раунд; numeric-literals Value-решение.
4. Релиз/push/мерж в main — ТОЛЬКО по явной команде. Апстрим в main: фикс 2 скобок
   rust_analyzer.rs (main не компилируется без него).

## ПРОЦЕСС (выстрадано, соблюдать)

- Конвейер: Workflow { имплементер(ы) → адверсариальный ревьюер с trap-list →
  независимый тест-раннер → fix }. За сессию поймал: pack-order pin, tombstone same-version
  stale, YAML bool-keys, trace_effects Array.isArray, cancel-as-convergence DATA LOSS,
  потерянную скобку глотавшую 5 тестов, INSTANCE_OF-гэп class-inheritance.
- **Ловушка: агент умирает на Monitor/долгом линке** (ночные fat-LTO 13+ мин) — его
  «результат» = промежуточное сообщение; журнал workflow: started без result = прерван
  сном. Ретраи продолжают поверх диффа в дереве. Долгие детерминированные цепочки —
  фоновым bash-скриптом под caffeinate, не агентом.
- Диета: полнографовый analyze = ОДИН раз на acceptance в git-worktree (dbPath жёстко
  <project>/.grafema — worktree изолирует); пробы/диффы на /tmp-копии
  (cp -R + rm LOCK + свой сервер на /tmp-сокете, убрать за собой).
- **Чужой сервер**: Atlas-сессия УМЕРЛА при ребуте 2026-06-12 (сокет стейловый) — констрейнт
  снят; правило остаётся: lsof перед любым pkill/rm на разделяемых ресурсах.
- Коммит после верифицированной волны; НИКОГДА не пушить без явной команды.
- MVCC: фикстуры обязаны flush(); v1-парсер на wire executeDatalog не принимает
  правила — у старых бинарей v2-роутинг через RFDB_DATALOG_V2=1 работает не для всех
  команд; для подсчётов по metadata — countEdgesByType + reachability + getOutgoingEdges.

## ГОТЧИ ОКРУЖЕНИЯ

- Stale-binary guard: после изменений Haskell — scripts/build-native.sh + проверка
  ~/.grafema/bin (cp/symlink); grafema-resolve без .build-hash ворнит freshness.
- Сон ноута: pmset починен для AC, на батарее спит — длинные прогоны через caffeinate -i;
  «N часов работы» проверять pmset log + monotonic.
- Относительные пути: cwd шелла мигрирует — только абсолютные пути в rm/analyze.
- Pre-commit hook гоняет JS-тесты — коммиты долгие, норм.
