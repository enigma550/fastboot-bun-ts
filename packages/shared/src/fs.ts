import { basename } from "node:path";
import { open, stat } from "node:fs/promises";

export async function getFileSize(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  return fileStat.size;
}

export async function withReadableFile<T>(
  filePath: string,
  work: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> {
  const handle = await open(filePath, "r");

  try {
    return await work(handle);
  } finally {
    await handle.close();
  }
}

export function fileLabel(filePath: string): string {
  return basename(filePath);
}
