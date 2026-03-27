import type { FastbootDevice, PlatformFix } from "fastboot-bun-ts/contracts/fastboot";

export interface FastbootUsbTransport {
  readonly identity: FastbootDevice;
  read(length: number): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<number>;
  close(): Promise<void>;
  reset(): Promise<void>;
  waitForDisconnect(timeoutMs?: number): Promise<boolean>;
}

export interface OpenTransportOptions {
  serial?: string;
  autoApplyPlatformFixes?: boolean;
  confirmPrivilegedFix?: (message: string) => Promise<boolean>;
  onPlatformFixStatus?: (message: string) => void;
  reconnectTimeoutMs?: number;
}

export interface OpenTransportResult {
  transport: FastbootUsbTransport;
  fix: PlatformFix;
}
