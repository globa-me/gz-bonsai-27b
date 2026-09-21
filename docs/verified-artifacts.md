# Проверенные артефакты

Дата проверки: 21 сентября 2026 года.

Этот файл отделяет сведения, полученные из актуальных официальных источников, от продуктовых гипотез и будущих измерений.

## Рекомендуемое семейство

Текущий флагман — **Ternary Bonsai 2 27B**, основанный на Qwen3.8 27B. Модель лицензирована под Apache 2.0 и опубликована в открытом репозитории `prism-ml/Ternary-Bonsai-2-27B-gguf`.

| Файл | Размер, байт | SHA-256 из Hugging Face LFS |
| --- | ---: | --- |
| `Ternary-Bonsai-2-27B-PTQ1_0.gguf` | 5 946 648 928 | `53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3` |
| `Ternary-Bonsai-2-27B-PQ2_0.gguf` | 7 206 168 928 | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` | 629 246 976 | `6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903` |
| `Ternary-Bonsai-2-27B-mmproj-BF16.gguf` | 931 145 856 | `e287342d92332fa3577ed1d42e921dac9370c08da58ba9337fa450f6cc76cfd7` |

Официальный demo по умолчанию выбирает `PQ2_0`; `PTQ1_0` меньше, но ни один формат не заявлен как безусловно более быстрый.

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
- корректность App Sandbox, Hardened Runtime и notarization со всеми runtime-библиотеками;
- независимая проверка заявленного качества модели.

До измерений эти пункты должны отображаться как оценка или эксперимент, а не как гарантия.
