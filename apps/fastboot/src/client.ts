import { Buffer } from "node:buffer";
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { getFileSize } from "fastboot-bun-ts/shared/fs";
import { parseSize } from "fastboot-bun-ts/shared/hex";
import {
  openFastbootTransport,
  type FastbootUsbTransport,
  type OpenTransportOptions,
} from "fastboot-bun-ts/usb";

import { FastbootProtocol, type FastbootProtocolCallbacks } from "./protocol";

const FILE_CHUNK_BYTES = 256 * 1024;

export interface FastbootClientOptions extends OpenTransportOptions, FastbootProtocolCallbacks {}

export class FastbootClient {
  public readonly protocol: FastbootProtocol;

  private cachedMaxDownloadSize?: number | null;

  private constructor(
    public readonly transport: FastbootUsbTransport,
    callbacks: FastbootProtocolCallbacks,
  ) {
    this.protocol = new FastbootProtocol(transport, callbacks);
  }

  public static async connect(
    options: FastbootClientOptions = {},
  ): Promise<FastbootClient> {
    const { transport } = await openFastbootTransport({
      ...options,
      onPlatformFixStatus: options.onInfo,
    });

    return new FastbootClient(transport, options);
  }

  public async close(): Promise<void> {
    await this.transport.close();
  }

  public async getVar(name: string): Promise<string> {
    return await this.protocol.getVar(name);
  }

  public async erase(partition: string): Promise<string> {
    return await this.protocol.erase(partition);
  }

  public async flash(partition: string): Promise<string> {
    return await this.protocol.flash(partition);
  }

  public async reboot(target?: string): Promise<string> {
    return await this.protocol.reboot(target);
  }

  public async setActive(slot: string): Promise<string> {
    return await this.protocol.setActive(slot);
  }

  public async oem(command: string): Promise<string> {
    return await this.protocol.oem(command);
  }

  public async downloadBytes(data: Uint8Array): Promise<void> {
    const maxDownloadSize = await this.getMaxDownloadSize();
    if (maxDownloadSize !== null && data.byteLength > maxDownloadSize) {
      throw new Error(
        `Payload size ${data.byteLength} exceeds device max-download-size ${maxDownloadSize}.`,
      );
    }

    await this.protocol.download(data);
  }

  public async downloadFile(filePath: string): Promise<void> {
    const fileSize = await getFileSize(filePath);
    const maxDownloadSize = await this.getMaxDownloadSize();

    if (maxDownloadSize !== null && fileSize > maxDownloadSize) {
      throw new Error(
        `File '${filePath}' is ${fileSize} bytes, larger than device max-download-size ${maxDownloadSize}.`,
      );
    }

    await this.protocol.beginDownload(fileSize);

    const handle = await open(filePath, "r");

    try {
      const buffer = Buffer.alloc(FILE_CHUNK_BYTES);
      let offset = 0;

      while (offset < fileSize) {
        const nextLength = Math.min(FILE_CHUNK_BYTES, fileSize - offset);
        const { bytesRead } = await handle.read(buffer, 0, nextLength, offset);
        if (bytesRead === 0) {
          throw new Error(
            `Unexpected EOF while reading '${filePath}' at offset ${offset}.`,
          );
        }

        const chunk = buffer.subarray(0, bytesRead);
        const written = await this.transport.write(chunk);
        if (written !== bytesRead) {
          throw new Error(
            `Short USB write while sending '${basename(filePath)}': wrote ${written} of ${bytesRead}.`,
          );
        }

        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }

    await this.protocol.finishDownload();
  }

  public async flashFile(partition: string, filePath: string): Promise<void> {
    await this.downloadFile(filePath);
    await this.flash(partition);
  }

  public async bootFile(filePath: string): Promise<void> {
    const bytes = await readFile(filePath);
    await this.protocol.boot(bytes);
  }

  public async getMaxDownloadSize(): Promise<number | null> {
    if (this.cachedMaxDownloadSize !== undefined) {
      return this.cachedMaxDownloadSize;
    }

    try {
      const value = await this.getVar("max-download-size");
      this.cachedMaxDownloadSize = parseSize(value);
      return this.cachedMaxDownloadSize;
    } catch {
      this.cachedMaxDownloadSize = null;
      return null;
    }
  }
}
