export function createSaveQueue<T>(write: (value: T) => Promise<void>) {
  let tail = Promise.resolve();
  return (value: T): Promise<void> => {
    const current = tail.then(() => write(value));
    tail = current.catch(() => undefined);
    return current;
  };
}
