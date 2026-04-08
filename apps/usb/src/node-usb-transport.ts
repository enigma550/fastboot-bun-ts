import type { Device, InEndpoint, OutEndpoint } from "usb";

import type { FastbootDevice } from "fastboot-bun-ts/contracts/fastboot";
import { poll } from "fastboot-bun-ts/shared/async";
import { TransportError } from "fastboot-bun-ts/shared/errors";

import type { FastbootUsbTransport } from "./types";

function toUint8Array(buffer: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export class NodeUsbFastbootTransport implements FastbootUsbTransport {
  public constructor(
    private readonly device: Device,
    private readonly input: InEndpoint,
    private readonly output: OutEndpoint,
    public readonly identity: FastbootDevice,
  ) {}

  public async read(length: number): Promise<Uint8Array> {
    const buffer = await this.input.transferAsync(length);
    if (buffer === undefined) {
      throw new TransportError("USB read returned no data.");
    }

    return toUint8Array(buffer);
  }

  public async write(data: Uint8Array): Promise<number> {
    const written = await this.output.transferAsync(Buffer.from(data));
    return written;
  }

  public async close(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.device.interface(this.identity.interfaceNumber).release(
          true,
          (error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      });
    } catch {
      // Ignore release failures during shutdown. Close still needs to run.
    }

    this.device.close();
  }

  public async reset(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.device.reset((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  public async waitForDisconnect(timeoutMs = 5_000): Promise<boolean> {
    const vanished = await poll(() => {
      try {
        this.device.open(false);
        this.device.close();
        return Promise.resolve<boolean | null>(null);
      } catch {
        return Promise.resolve<boolean | null>(true);
      }
    }, { timeoutMs, intervalMs: 200 });

    return vanished ?? false;
  }
}
