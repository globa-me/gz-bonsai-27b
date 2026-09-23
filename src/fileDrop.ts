const RAG_ONLY_EXTENSIONS = new Set(["pdf", "docx"]);
const CHOICE_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json"]);

function extension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const separator = name.lastIndexOf(".");
  return separator >= 0 ? name.slice(separator + 1).toLowerCase() : "";
}

export function classifyDroppedPaths(paths: string[]) {
  const ragPaths: string[] = [];
  const attachmentPaths: string[] = [];
  const choicePaths: string[] = [];

  for (const path of paths) {
    if (RAG_ONLY_EXTENSIONS.has(extension(path))) ragPaths.push(path);
    else if (CHOICE_EXTENSIONS.has(extension(path))) choicePaths.push(path);
    else attachmentPaths.push(path);
  }

  return { ragPaths, attachmentPaths, choicePaths };
}
