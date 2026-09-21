# Разработка

## Подготовка и запуск

```bash
rustup default stable
npm install
npm run tauri -- dev
```

Frontend отдельно можно открыть через `npm run dev`, но системные Tauri-команды в обычном браузере недоступны.

Подписанный runtime находится в `src-tauri/runtime/prism-b10709-9a9394a` и попадает в `Contents/Resources/runtime`. Происхождение, состав и обновление описаны в [runtime-bundle.md](runtime-bundle.md).

## Тесты

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Релизный чек-лист

1. Сверить официальные страницы PrismML и GitHub release форка llama.cpp.
2. Обновить `docs/verified-artifacts.md`, если поменялись имена, размеры, SHA-256 или лицензии.
3. Выполнить все тесты и собрать DMG.
4. Проверить `hdiutil verify`, `file`, `codesign --verify --deep --strict`.
5. Отправить app/DMG на notarization Apple и выполнить stapling.
6. Проверить все вложенные Mach-O в `Contents/Resources/runtime`, затем установку перетаскиванием в Applications и полный путь каталог → загрузка → health → чат.
7. Только затем прикрепить DMG к GitHub Release.

Встроенного автообновления намеренно нет. Новая версия публикуется отдельным GitHub Release.
