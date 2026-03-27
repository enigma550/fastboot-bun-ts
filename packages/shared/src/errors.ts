export class FastbootError extends Error {
  public override readonly cause?: unknown;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.cause = options?.cause;
  }
}

export class TransportError extends FastbootError {}

export class DeviceNotFoundError extends FastbootError {}

export class RemoteFastbootError extends FastbootError {
  public constructor(
    message: string,
    public readonly response: string,
  ) {
    super(message);
  }
}

export class PlatformFixError extends FastbootError {}

export class PlatformFixDeclinedError extends PlatformFixError {}
