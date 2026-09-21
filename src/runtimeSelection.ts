export function resolveRuntimePath(
  currentRuntimePath: string,
  selectedModelPath: string,
  bundledRuntimePath: string | null | undefined,
  managedModelPaths: Array<string | null | undefined>,
): string {
  if (!bundledRuntimePath) return currentRuntimePath;
  const managedModelSelected = managedModelPaths.some((path) => Boolean(path) && path === selectedModelPath);
  return !currentRuntimePath || managedModelSelected ? bundledRuntimePath : currentRuntimePath;
}
