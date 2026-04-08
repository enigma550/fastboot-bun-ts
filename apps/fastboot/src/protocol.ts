import { Buffer } from "node:buffer";

import type { FastbootStatusPacket } from "fastboot-bun-ts/contracts/fastboot";
import { RemoteFastbootError, TransportError } from "fastboot-bun-ts/shared/errors";

import type { FastbootUsbTransport } from "fastboot-bun-ts/usb";

const MAX_COMMAND_BYTES = 4096;
const MAX_RESPONSE_BYTES = 256;
const DEFAULT_IO_CHUNK_BYTES = 256 * 1024;

export interface FastbootProtocolCallbacks {
  onInfo?: (message: string) => void;
  onText?: (message: string) => void;
}

function decodeAscii(data: Uint8Array): string {
  return Buffer.from(data).toString("utf8");
}

function parsePacket(data: Uint8Array): FastbootStatusPacket {
  const message = decodeAscii(data);
  const kind = message.slice(0, 4);
  const payload = message.slice(4);

  switch (kind) {
    case "INFO":
    case "TEXT":
    case "DATA":
    case "OKAY":
    case "FAIL":
      return { kind, payload };
    default:
      throw new TransportError(`Unexpected Fastboot response '${message}'.`);
  }
}

export class FastbootProtocol {
  public constructor(
    private readonly transport: FastbootUsbTransport,
    private readonly callbacks: FastbootProtocolCallbacks = {},
  ) {}

  public async command(command: string): Promise<string> {
    const response = await this.exchangeCommand(command);
    return response.payload;
  }

  public async getVar(name: string): Promise<string> {
    return await this.command(`getvar:${name}`);
  }

  public async erase(partition: string): Promise<string> {
    return await this.command(`erase:${partition}`);
  }

  public async flash(partition: string): Promise<string> {
    return await this.command(`flash:${partition}`);
  }

  public async reboot(target?: string): Promise<string> {
    const command = target === undefined ? "reboot" : `reboot-${target}`;
    return await this.command(command);
  }

  public async setActive(slot: string): Promise<string> {
    return await this.command(`set_active:${slot}`);
  }

  public async oem(command: string): Promise<string> {
    return await this.command(`oem ${command}`);
  }

  public async boot(image: Uint8Array): Promise<string> {
    await this.download(image);
    return await this.command("boot");
  }

  public async beginDownload(size: number): Promise<void> {
    const hexSize = size.toString(16).padStart(8, "0");
    const start = await this.exchangeCommand(`download:${hexSize}`);
    const acceptedSize = Number.parseInt(start.payload, 16);

    if (Number.isNaN(acceptedSize) || acceptedSize !== size) {
      throw new TransportError(
        `Device accepted ${start.payload} bytes, expected ${hexSize}.`,
      );
    }
  }

  public async finishDownload(): Promise<void> {
    const terminal = await this.readTerminalResponse();
    if (terminal.kind !== "OKAY") {
      throw new TransportError(`Unexpected terminal response '${terminal.kind}'.`);
    }
  }

  public async download(data: Uint8Array): Promise<void> {
    await this.beginDownload(data.byteLength);

    for (let offset = 0; offset < data.byteLength; offset += DEFAULT_IO_CHUNK_BYTES) {
      const chunk = data.slice(offset, offset + DEFAULT_IO_CHUNK_BYTES);
      const written = await this.transport.write(chunk);

      if (written !== chunk.byteLength) {
        throw new TransportError(
          `Short USB write: wrote ${written} of ${chunk.byteLength} bytes.`,
        );
      }
    }

    await this.finishDownload();
  }

  public async readData(size: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (received < size) {
      const chunkSize = Math.min(DEFAULT_IO_CHUNK_BYTES, size - received);
      const packet = await this.transport.read(chunkSize);
      if (packet.byteLength === 0) {
        throw new TransportError("USB read returned an empty packet.");
      }

      chunks.push(packet);
      received += packet.byteLength;
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  }

  private async exchangeCommand(command: string): Promise<FastbootStatusPacket> {
    const encoded = Buffer.from(command, "utf8");
    if (encoded.byteLength > MAX_COMMAND_BYTES) {
      throw new TransportError(
        `Fastboot command exceeds ${MAX_COMMAND_BYTES} bytes.`,
      );
    }

    const written = await this.transport.write(encoded);
    if (written !== encoded.byteLength) {
      throw new TransportError(
        `Short USB write: wrote ${written} of ${encoded.byteLength} command bytes.`,
      );
    }

    return await this.readTerminalResponse();
  }

  private async readTerminalResponse(): Promise<FastbootStatusPacket> {
    while (true) {
      const packet = parsePacket(await this.transport.read(MAX_RESPONSE_BYTES));

      switch (packet.kind) {
        case "INFO":
          this.callbacks.onInfo?.(packet.payload);
          continue;
        case "TEXT":
          this.callbacks.onText?.(packet.payload);
          continue;
        case "DATA":
          return packet;
        case "OKAY":
          return packet;
        case "FAIL":
          throw new RemoteFastbootError(
            `Fastboot failed: ${packet.payload}`,
            packet.payload,
          );
      }
    }
  }
}
