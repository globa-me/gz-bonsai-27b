# Переход подписи macOS на G2 — 2 октября 2026

## Статус

Подготовлен выпуск GZ Bonsai 27B 0.6.6 с новым Developer ID Application. Поддерживаемый артефакт остаётся DMG для Apple Silicon (arm64). На момент проверки доступного G2 с закрытым ключом в Keychain нет. Новый DMG не собран, не нотарифицирован и не опубликован. Срок и SHA-1 нового сертификата пока неизвестны.

Общий G2 получает чат GZWhisper «Разобрать сбой транскрибации» (`01a0f1a1-bc8d-7f02-a85b-b96f520a34fd`). В этом проекте сертификаты не создавались и не отзывались. Требуется команда `BN3D9H4C7J` и issuer **OU=G2**; совпадающее имя само по себе недостаточно. По [инструкции Apple](https://developer.apple.com/help/account/certificates/replace-developer-id-certificates) новые сертификаты G2 действуют один год и требуют ежегодного продления.

## Что проверено

Из GitHub [v0.6.6](https://github.com/globa-me/gz-bonsai-27b/releases/tag/v0.6.6) заново скачан `GZ-Bonsai-27B-0.6.6-arm64.dmg`, 30 560 805 bytes. SHA-256 совпал с API и историческим документом:

```text
6a07af6c12c2e9f73297d31cb5589a473cff4589462ba44b76310a5b8819e241
```

DMG смонтирован read-only; подпись app bundle прошла `codesign --verify --deep --strict`, secure timestamp присутствует. Из скачанного приложения извлечён публичный leaf-сертификат: SHA-1 `0B4AEF20C0E48C3D8A6C1A7B9A82330EBA64806F`, issuer OU=`Apple Certification Authority`, срок до `2027-02-01 22:12:15 UTC`. Это прежняя подпись, не G2. Старый сертификат сохранён.

Профиль `GZB-notary` доступен через `notarytool history`. В репозитории нет GitHub Actions signing secrets (`gh secret list` вернул пустой список); текущая CI только проверяет код. Релиз подписывается локально, обновление CI signing secrets для него не требуется. Значения секретов и закрытые ключи не извлекались.

2 октября повторно прочитаны [официальная документация PrismML](https://docs.prismml.com/bonsai-2-27b) и [статья Bonsai 2](https://prismml.com/news/bonsai-2-27b). Hugging Face API по закреплённым commits подтвердил имена, URL, размеры, LFS SHA-256 и Apache 2.0 всех шести весов и двух Q8-projector. Каталог и runtime `prism-b10709-9a9394a` не обновляются при замене подписи.

## Подготовленный процесс

- `scripts/macos_signing.py identity` выбирает единственный действующий G2 для нужной команды с доступной signing identity. При нескольких кандидатах SHA-1 задаётся через `BONSAI_SIGNING_IDENTITY`. Имя сертификата вместо SHA-1 отклоняется.
- `scripts/build-macos-g2.py` прекращает работу до сборки, если G2 отсутствует. Копирует runtime в временный staging внутри игнорируемого `output/`, переподписывает все его реальные Mach-O с `--timestamp --options runtime`, затем собирает app и DMG. Отслеживаемые runtime-бинарники не меняются.
- Tauri получает точный SHA-1 через конфигурационный override и `APPLE_SIGNING_IDENTITY`. Статическое `signingIdentity` в `tauri.conf.json` равно `null`; обычный developer build не считается подписанным релизом. [Tauri документирует](https://v2.tauri.app/distribute/sign/macos/) выбор identity через config/env; [resources map](https://v2.tauri.app/reference/config/#bundleconfig) помещает копию runtime в прежний путь `Contents/Resources/runtime`.
- Проверка сверяет issuer G2, команду, срок и SHA-1 у bundle и всех Mach-O, secure timestamp (`Signed Time` недостаточно), `codesign --deep --strict` и arm64. `prepare-runtime.sh` также требует G2 для будущего обновления runtime и устанавливает каталог только после подписи и проверки staging. Независимая проверка скриптов выявила и исправила прежнюю возможность оставить частично подписанный runtime и отсутствие arm64-проверки для отдельного файла.
- Результат сборки: `output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg` и `output/g2/build-report.json`. Суффикс G2 отличает перевыпуск того же приложения от исторического DMG.

Семь тестов требований подписи проходят. Реальный старый сертификат отклоняется и при выборе identity, и при проверке установленного приложения. Запуск builder подтверждённо завершается до сборки из-за отсутствия G2. Полная ветка сборки/staging, новая подпись, notarization, Gatekeeper и запуск G2-сборки **ещё не проверены**.

## Продолжить после появления общего G2

1. Выполнить `python3 scripts/macos_signing.py identity`. Записать публичный SHA-1, issuer, даты выдачи/истечения нового сертификата в этот документ. Если кандидатов несколько, задать `BONSAI_SIGNING_IDENTITY` равным конкретному SHA-1. Не отзывать прежний сертификат.
2. Установить зависимости `npm ci`, выполнить обычные проверки из `development.md` и дополнительные тесты:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p test_macos_signing.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build-macos-g2.py
```

3. Проверить пути runtime в сохранённом app, issuer и timestamp всех вложенных подписей. `build-report.json` содержит результаты подписи, но его поля `notarized` и `published` изначально false.
4. Отправить финальный DMG на Apple notarization и staple:

```bash
xcrun notarytool submit output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg --keychain-profile GZB-notary --wait
xcrun stapler staple output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg
xcrun stapler validate output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg
spctl --assess --type open --context context:primary-signature -vv output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg
hdiutil verify output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg
shasum -a 256 output/g2/GZ-Bonsai-27B-0.6.6-arm64-G2.dmg
```

5. Смонтировать DMG read-only, проверить извлечённое приложение через `macos_signing.py verify <app> --arm64 --sha1 <G2_SHA1>`, Gatekeeper execute и запуск. Для runtime smoke использовать собственный bundle/test library или защищённую копию существующих данных; пользовательские модели не удалять.
6. Добавить G2 DMG в существующий v0.6.6 (`gh release upload`), сохранив исторический файл. Обновить README download URL на имя с `-G2`, дополнить release notes датой переподписи, публичными данными нового сертификата и финальным SHA-256 после stapling. Исторический `e2e-0.6.6.md` и его старый SHA не переписывать как будто первоначальная сборка была G2.
7. Заново скачать именно загруженный G2 asset в отдельную папку. Сопоставить SHA-256/размер с локальным финальным файлом и GitHub API, извлечь подпись app, проверить G2/timestamp/Gatekeeper. После этого записать release URL, submission id, результаты smoke и статус публикации; merge подготовленных исходников/документации с сохранением чужих изменений.

## Handoff

Работа изолирована в managed worktree `g2-signing`, ветка `codex/g2-signing`. В исходном checkout есть прежнее незавершённое изменение `docs/development.md`; оно не переносилось и не менялось. На момент подготовки blocker — отсутствие пригодного общего G2 в Keychain. Старый опубликованный v0.6.6 остаётся доступным. Переподпись прежним сертификатом не выполнялась.
