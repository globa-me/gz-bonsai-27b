import type { Attachment, ChatMessage } from "./chatStore";

export type PromptContent = string | Array<Record<string, unknown>>;

export function promptContent(message: ChatMessage, describeImages: string, includeAttachments: boolean): PromptContent {
  if (!includeAttachments) return message.content;
  const text = [message.content, ...(message.attachments ?? [])
    .filter((attachment) => attachment.kind === "text")
    .map((attachment) => `\n\n<attached_file name="${attachment.name}">\n${attachment.content}\n</attached_file>`)].join("").trim();
  const images = (message.attachments ?? []).filter((attachment) => attachment.kind === "image");
  return images.length
    ? [{ type: "text", text: text || describeImages }, ...images.map((attachment: Attachment) => ({ type: "image_url", image_url: { url: attachment.content } }))]
    : text;
}

// Keep recent dialogue, but never replay a previous file or image payload.
export function buildPromptHistory(messages: ChatMessage[], current: ChatMessage, describeImages: string) {
  const previous = messages.filter((message) => !(message.role === "assistant" && message.error)).slice(-8);
  return [...previous.map((message) => ({ role: message.role, content: promptContent(message, describeImages, false) })),
    { role: current.role, content: promptContent(current, describeImages, true) }];
}
