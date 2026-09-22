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
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
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

## Apple signing и notarization

Несекретные параметры релиза:

- Developer ID: `Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)`;
- Apple ID: `global_corp@mail.ru`;
- Team ID: `BN3D9H4C7J`;
- профиль `notarytool` в macOS Keychain: `GZB-notary`.

Пароль приложения и другие секреты в проект не записываются. Проверить сохранённый профиль без раскрытия секрета можно командой:

```bash
xcrun notarytool history --keychain-profile "GZB-notary"
```

Tauri подписывает app bundle и DMG через доступный сертификат Developer ID. После сборки DMG нужно переименовать с генерируемого суффикса `_x64` в `-arm64`: на Apple Silicon текущий bundler использует ошибочное имя файла, хотя `file Contents/MacOS/bonsai-desktop` подтверждает arm64.

Финальная последовательность:

```bash
xcrun notarytool submit "GZ-Bonsai-27B-VERSION-arm64.dmg" \
  --keychain-profile "GZB-notary" \
  --wait
xcrun stapler staple "GZ-Bonsai-27B-VERSION-arm64.dmg"
xcrun stapler validate "GZ-Bonsai-27B-VERSION-arm64.dmg"
spctl --assess --type open --context context:primary-signature -vv \
  "GZ-Bonsai-27B-VERSION-arm64.dmg"
hdiutil verify "GZ-Bonsai-27B-VERSION-arm64.dmg"
```

Если профиль Keychain перестал работать, пересоздать его следует вручную через `xcrun notarytool store-credentials "GZB-notary"`; секрет не передавать в чат и не добавлять в Git.
