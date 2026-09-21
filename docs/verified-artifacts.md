# Проверенные артефакты

Дата проверки: 21 сентября 2026 года.

Этот файл отделяет сведения, полученные из актуальных официальных источников, от продуктовых гипотез и будущих измерений.

## Компактные варианты

Каталог `0.2.0` использует Q1_0-файлы из официальных репозиториев PrismML. URL закреплены на конкретные Hugging Face commits, а LFS OID используется как ожидаемый SHA-256.

| Модель | Commit | Файл | Размер, байт | SHA-256 |
| --- | --- | --- | ---: | --- |
| Bonsai 1.7B | `210a9e99f79cb184909d49595906526eb2b3dd9a` | `Bonsai-1.7B-Q1_0.gguf` | 248 302 272 | `3d7c6c90dd98717a203adb22d5eacd2581850e40aa5327e144b97766cae5f7e3` |
| Bonsai 4B | `78f2c2bacd0904ffaba24b4873ed975e5818354a` | `Bonsai-4B-Q1_0.gguf` | 572 270 624 | `4524b3f997f0f06444e568d1f26e2efd69effa3218c7ad3047432fb171e42168` |
| Bonsai 8B | `48516770dd04643643e9f9019a2a349cf26c5dbd` | `Bonsai-8B-Q1_0.gguf` | 1 158 654 496 | `284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54` |
| Bonsai 27B, 1-bit | `f10afb355f104535e3e3e98cf7ab7795c72bd292` | `Bonsai-27B-Q1_0.gguf` | 3 803 452 480 | `17ef842e47450caeb8eaa3ebfbbab5d2f2278b62b79be107985fb69a2f819aa0` |

Источники:

- <https://huggingface.co/prism-ml/Bonsai-1.7B-gguf>
- <https://huggingface.co/prism-ml/Bonsai-4B-gguf>
- <https://huggingface.co/prism-ml/Bonsai-8B-gguf>
- <https://huggingface.co/prism-ml/Bonsai-27B-gguf>

## Рекомендуемое семейство

Текущий тернарный флагман — **Ternary Bonsai 2 27B**, основанный на Qwen3.8 27B. Модель лицензирована под Apache 2.0 и опубликована в открытом репозитории `prism-ml/Ternary-Bonsai-2-27B-gguf`. Обе упаковки ниже содержат тернарные веса `{−1, 0, +1}`: `PTQ1_0` плотнее упаковывает trits, а `PQ2_0` хранит trit в двухбитном слоте. Название `PTQ1_0` не означает, что это бинарная 1-битная модель; бинарная Bonsai 27B перечислена отдельно выше.

| Файл | Размер, байт | SHA-256 из Hugging Face LFS |
| --- | ---: | --- |
| `Ternary-Bonsai-2-27B-PTQ1_0.gguf` | 5 946 648 928 | `53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3` |
| `Ternary-Bonsai-2-27B-PQ2_0.gguf` | 7 206 168 928 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` | 629 246 976 | `6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903` |
| `Ternary-Bonsai-2-27B-mmproj-BF16.gguf` | 931 145 856 | `e287342d92332fa3577ed1d42e921dac9370c08da58ba9337fa450f6cc76cfd7` |

Официальный demo по умолчанию выбирает `PQ2_0`; `PTQ1_0` меньше, но ни один формат не заявлен как безусловно более быстрый. Каталог приложения предоставляет обе упаковки.

Источники:

- <https://docs.prismml.com/bonsai-2-27b>
- <https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf>
- <https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2-27B-gguf/tree/main?recursive=true&expand=true>

## Совместимый runtime

Bonsai 2 требует форк `PrismML-Eng/llama.cpp` версии `prism-b10658` или новее. Обычный upstream llama.cpp для форматов `PQ2_0` и `PTQ1_0` не считается совместимым.

На дату проверки актуальный релиз: `prism-b10709-9a9394a`, опубликован 18 сентября 2026 года.

macOS arm64 архив:

- файл: `llama-prism-b10709-9a9394a-bin-macos-arm64.tar.gz`;
- размер: 11 500 187 байт;
- SHA-256: `f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff`;
- URL: <https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-macos-arm64.tar.gz>.

Форк llama.cpp распространяется по лицензии MIT. При будущей упаковке бинарников приложение должно включать текст этой лицензии и уведомления всех поставляемых динамических библиотек.

Источники:

- <https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10709-9a9394a>
- <https://github.com/PrismML-Eng/llama.cpp/blob/master/LICENSE>

## Что пока не доказано

- безопасные пороги RAM для автоматической рекомендации;
- скорость prompt processing и генерации на конкретных M-series;
- максимальный практический контекст для каждого объёма unified memory;
- поведение App Sandbox, если он будет включён в будущем; текущий Developer ID + Hardened Runtime bundle со всеми runtime-библиотеками проверен `codesign --deep --strict`, Gatekeeper и Apple Notary Service;
- независимая проверка заявленного качества модели.

До измерений эти пункты должны отображаться как оценка или эксперимент, а не как гарантия.
