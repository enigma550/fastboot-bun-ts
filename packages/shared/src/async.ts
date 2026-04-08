export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function poll<T>(
  work: () => Promise<T | null>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<T | null> {
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const result = await work();
    if (result !== null) {
      return result;
    }

    await sleep(intervalMs);
  }

  return null;
}
