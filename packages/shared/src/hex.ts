export function formatUsbId(value: number): string {
  return value.toString(16).padStart(4, "0");
}

export function formatUsbRevision(value: number): string {
  return value.toString(16).padStart(4, "0");
}

export function parseSize(value: string): number | null {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.startsWith("0x")) {
    return Number.parseInt(trimmed.slice(2), 16);
  }

  if (/^[0-9a-f]+$/.test(trimmed) && /[a-f]/.test(trimmed)) {
    return Number.parseInt(trimmed, 16);
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return null;
}
