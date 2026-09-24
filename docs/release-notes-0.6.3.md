# 0.6.3 — происхождение моделей в каталоге

Дата: 24 сентября 2026 года.

## Изменение

В быстром старте и карточках каталога под названием Bonsai добавлена компактная строка «Основа: Qwen…» и две отдельные ссылки на Hugging Face: текущую сборку Bonsai и исходную Qwen. В верхнем меню выбора установленных моделей Qwen видна в строке модели; ссылки расположены отдельно от кнопки запуска, поэтому открыть карточку можно без случайного переключения модели. Названия ссылок доступны для VoiceOver; RU/EN локализованы.

| Вариант Bonsai | Основа Qwen |
| --- | --- |
| 1.7B Q1_0 | [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B) |
| 4B Q1_0 | [Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) |
| 8B Q1_0 | [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) |
| 27B 1-bit Q1_0 | [Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) |
| Bonsai 2 27B PTQ1_0 и PQ2_0 | [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) |

Источник сопоставления: официальные карточки [Bonsai 1.7B](https://huggingface.co/prism-ml/Bonsai-1.7B-gguf), [4B](https://huggingface.co/prism-ml/Bonsai-4B-gguf), [8B](https://huggingface.co/prism-ml/Bonsai-8B-gguf), [27B](https://huggingface.co/prism-ml/Bonsai-27B-gguf) и [Bonsai 2 27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf). Для малых моделей карточки PrismML указывают архитектуру Qwen3 соответствующего размера; для 27B в карточках явно указана исходная модель.

URL, размер и SHA-256 скачиваемых GGUF не менялись. Проверка сборки и установленного приложения — [e2e-0.6.3.md](e2e-0.6.3.md).
