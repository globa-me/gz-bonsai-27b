# Встроенный PrismML runtime

## Почему runtime находится внутри приложения

Официальный macOS arm64 архив PrismML содержит ad-hoc подписанные Mach-O без Team ID. Gatekeeper не принимает отдельный `llama-server` как самостоятельно распространяемый Developer ID executable. Поэтому релиз не скачивает runtime после установки: минимальный необходимый набор входит в нотариально заверенный app bundle.

## Происхождение

- upstream: `PrismML-Eng/llama.cpp`;
- release: `prism-b10709-9a9394a`;
- архив: `llama-prism-b10709-9a9394a-bin-macos-arm64.tar.gz`;
- размер архива: `11 500 187` байт;
- SHA-256 архива: `f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff`;
- лицензия: MIT, копия находится рядом с runtime как `LICENSE`.

В bundle включены `llama-server`, все `lib*.dylib` из официального архива и их относительные symlink. Остальные CLI-инструменты не включаются.

## Подпись

Каждый физический Mach-O подписывается `Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)` с timestamp и hardened runtime. После этого Tauri подписывает весь `.app`; DMG отправляется в Apple Notary Service и stapling.

Подготовку новой версии выполняет `scripts/prepare-runtime.sh`. Скрипт отказывается перезаписывать существующий каталог, проверяет SHA-256 до извлечения и требует доступную signing identity.

## Release gate

Перед публикацией обязательно проверить:

```bash
codesign --verify --deep --strict --verbose=4 "GZ Bonsai 27B.app"
find "GZ Bonsai 27B.app/Contents/Resources/runtime" -type f -print0 | \
  xargs -0 file | grep Mach-O
spctl --assess --type execute -v "GZ Bonsai 27B.app"
```

Затем выполняется полный smoke-тест из установленного app bundle, а не из исходного официального архива.
