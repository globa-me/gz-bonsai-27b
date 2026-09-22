export interface MessageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  elapsedMs: number;
  tokensPerSecond: number;
  promptTokensPerSecond?: number | null;
}

export interface ChatMetricsSummary extends MessageMetrics {
  responses: number;
}

export function summarizeMetrics(
  metrics: Array<MessageMetrics | undefined>,
): ChatMetricsSummary | null {
  const measured = metrics.filter((value): value is MessageMetrics => Boolean(value));
  if (!measured.length) return null;

  const promptTokens = measured.reduce((total, value) => total + value.promptTokens, 0);
  const completionTokens = measured.reduce((total, value) => total + value.completionTokens, 0);
  const elapsedMs = measured.reduce((total, value) => total + value.elapsedMs, 0);
  const generationSeconds = measured.reduce((total, value) => {
    if (value.completionTokens <= 0 || value.tokensPerSecond <= 0) return total;
    return total + value.completionTokens / value.tokensPerSecond;
  }, 0);

  return {
    responses: measured.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    elapsedMs,
    tokensPerSecond: generationSeconds > 0 ? completionTokens / generationSeconds : 0,
  };
}
