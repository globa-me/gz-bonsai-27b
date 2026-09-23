export function boundedRepetitionCount(prompt: string): number | null {
  const text = prompt.trim().toLowerCase();
  if (!/^(?:повтори|напиши|выведи|repeat|write|print)(?:\s|:)/u.test(text)) return null;
  const match = text.slice(0, 300).match(/(?:^|\s)(\d{1,3})\s*(?:раз|times)(?:\s|[.,;:!?]|$)/u);
  const count = Number(match?.[1]);
  return Number.isInteger(count) && count >= 2 ? count : null;
}
