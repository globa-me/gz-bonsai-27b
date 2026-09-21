<p align="center"><img src="src-tauri/icons/icon.png" width="112" alt="GZ Bonsai 27B" /></p>
<h1 align="center">GZ Bonsai 27B</h1>
<p align="center">Простое открытое macOS-приложение для приватного запуска моделей Bonsai на своём Mac.</p>
<p align="center">
  <a href="https://github.com/globa-me/gz-bonsai-27b/releases/tag/v0.3.0"><img alt="Release 0.3.0" src="https://img.shields.io/badge/stable-0.3.0-2f6949" /></a>
  <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-2f6949" />
  <img alt="License MIT" src="https://img.shields.io/badge/code-MIT-dceee2" />
</p>

![Интерфейс GZ Bonsai 27B](docs/images/app-overview.png)

## Скачать

[Скачать GZ Bonsai 27B 0.3.0 для Apple Silicon](https://github.com/globa-me/gz-bonsai-27b/releases/download/v0.3.0/GZ-Bonsai-27B-0.3.0-arm64.dmg) — подписанный  Apple DMG. Перетащите приложение в папку Applications.

Совместимый runtime уже находится внутри приложения. Откройте «Модели», скачайте выбранный вариант и запустите локальный чат.

## Зачем вам этот проект

Официальные модели PrismML можно запускать локально, но новичку приходится разбираться в GGUF, совместимых сборках llama.cpp, портах, контексте и командах терминала и т.д. Мое маленькое приложение упрощает процесс. Скачал, установил, выбрал модель и работаешь.

Что важно знать:

- данные и сообщения остаются на вашем компьютере;
- сервер слушает только `127.0.0.1`;
- русский интерфейс включён по умолчанию, английский доступен переключателем;
- рекомендации по памяти это РЕКОМЕНДАЦИИ, экспериментируйте со своей машиной и смотрите, что будет лучше работать;
- диагностику можно скопировать одной кнопкой и отправить мне на gennadiy@zakharov.asia если что-то не работает;
- обновления устанавливаются вручную из GitHub Releases — сорян, пока встроенного автообновления нет.

## Что уже работает

Текущий `0.3.0` — рабочая версия для macOS на Apple Silicon:

- Tauri 2 + React + TypeScript;
- определение чипа, архитектуры, RAM, версии macOS и свободного места;
- подписанный PrismML `llama-server` внутри приложения;
- каталог Bonsai 1.7B, 4B, 8B, полной 1-битной Bonsai 27B и двух упаковок ternary Bonsai 2 27B;
- загрузка с паузой, возобновлением, отменой, проверкой размера и SHA-256;
- безопасное удаление установленных моделей;
- ручной выбор собственного GGUF и необязательного `mmproj` в расширенных настройках;
- запуск процесса только на localhost, проверка занятого порта и health check;
- потоковый ответ через `/v1/chat/completions`;
- отдельная карточка OpenAI-совместимого endpoint по адресу `http://127.0.0.1:8080/v1` (можно скопировать в настройках);
- чаты, история Markdown;
- автоматическая загрузка проверенного vision projector для 27B-моделей; 1.7B, 4B и 8B отмечены как text-only;
- включаемый веб-поиск: запрос отправляется Bing;
- RU/EN-локализация;
- подписанная сборка с моим Developer ID.

![Каталог и рекомендация модели](docs/images/model-catalog.png)

## Что ещё не готово

- измеренная матрица RAM, скорости и контекста для разных M-series —  по хорошему, статистика нужна;
- переименование и удаление отдельных чатов - скоро допилю;
- MCP-инструменты помимо встроенного веб-поиска;
- интеграции OpenCode и Tailscale;
- автоматическое обновление — новые версии пока устанавливаются вручную из GitHub Releases.

## Пара слов вро PrismML llama.cpp

В каталоге 27B намеренно разделены две технологии: бинарная **Bonsai 27B 1-bit** (`Q1_0`, 3,80 ГБ) и тернарная **Bonsai 2 27B** (`PTQ1_0`, 5,95 ГБ; `PQ2_0`, 7,21 ГБ). Для этих специальных форматов используется встроенный форк `PrismML-Eng/llama.cpp`; обычная сборка upstream llama.cpp не считается совместимой.

Актуальные проверенные имена файлов, размеры, SHA-256 и лицензии записаны в [docs/verified-artifacts.md](docs/verified-artifacts.md).

Приложение использует `llama.cpp` с Metal (`-ngl 99`) — это нативный метод для Apple Silicon. Оно не выдаёт этот runtime за MLX: официальный MLX-путь требует отдельного Python либо Swift inference host.

## Запуск из исходников

Требования: macOS 13+, Apple Silicon, Node.js, Rust stable и Xcode Command Line Tools.

```bash
npm install
npm run tauri -- dev
```

В приложении откройте «Модели», скачайте вариант из каталога и нажмите «Запустить модель». Ручной выбор `llama-server`, GGUF и `mmproj` остаётся в дополнительных параметрах. Полные инструкции: [docs/development.md](docs/development.md).

## Проверка

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Тесты проверяют синхронность RU/EN-каталогов, целостность manifest моделей, обязательный bind к loopback, аргументы vision projector и разбор OpenAI SSE-потока.

Дополнительно выполнен реальный smoke-тест на Apple M3 Pro: официальный runtime `prism-b10709-9a9394a` загрузил Bonsai 1.7B Q1_0, прошёл health check и вернул потоковый ответ. Условия и границы проверки: [docs/smoke-test-2026-09-21.md](docs/smoke-test-2026-09-21.md).

## Сборка подписанного DMG

```bash
npm run tauri -- build --bundles dmg
```

В `src-tauri/tauri.conf.json` закреплена подпись `Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)`. Публичный DMG подписан, нотариально заверен Apple и проверен Gatekeeper. На чужой машине значение нужно заменить либо убрать для неподписанной локальной сборки. Секреты нотариального сервиса не хранятся в репозитории.

## Архитектура и безопасность

- React отвечает за интерфейс и локализацию.
- Rust управляет проверяемыми загрузками, `llama-server`, health check и streaming API через Tauri events.
- Все сетевые артефакты закреплены commit URL, размером и SHA-256; готовый GGUF появляется только после проверки и атомарного переименования.
- Runtime и его dylib подписаны Developer ID и находятся внутри нотариально заверенного app bundle.
- Полные пути удаляются из диагностического отчёта.
- Веса `*.gguf`, временные загрузки и build-артефакты исключены из Git.
- Сетевой адрес жёстко ограничен `127.0.0.1`.

Подробности: [docs/architecture.md](docs/architecture.md).

## Лицензии

Код приложения распространяется по лицензии [MIT](LICENSE). PrismML Bonsai weights — Apache 2.0, PrismML llama.cpp fork — MIT. Веса моделей не входят в репозиторий и DMG.

## Автор

Разработано [Геннадием Захаровым](https://zakharov.asia/ru/).

Проект не является официальным приложением PrismML. Названия моделей и сторонние товарные знаки принадлежат их владельцам.
