import { useUsbDkBackend } from "usb";
import { Buffer } from "node:buffer";

import type { PlatformFix } from "fastboot-bun-ts/contracts/fastboot";
import { getRuntimePlatform } from "fastboot-bun-ts/shared/platform";
import {
  PlatformFixDeclinedError,
  PlatformFixError,
  TransportError,
} from "fastboot-bun-ts/shared/errors";

import {
  findFastbootDevice,
  waitForFastbootDevice,
  waitForFastbootDeviceRemoval,
} from "./discovery";
import { NodeUsbFastbootTransport } from "./node-usb-transport";
import { ensurePlatformFix, getPlatformFixState } from "./platform-fixes";
import type { OpenTransportOptions, OpenTransportResult } from "./types";

const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 256;

type ProbeOutcome = "success" | "busy" | "failure";

interface ProbeSummary {
  kind: "ready" | "busy-only" | "fix-required";
  summary: string;
  canContinue: boolean;
}

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toUpperCase().includes("LIBUSB_ERROR_BUSY")
  );
}

async function runGetVarProductProbe(serial?: string): Promise<ProbeOutcome> {
  let claimed: Awaited<ReturnType<typeof findFastbootDevice>> | null = null;
  let transport: NodeUsbFastbootTransport | null = null;

  try {
    claimed = await findFastbootDevice(serial);

    try {
      claimed.usbDevice.setAutoDetachKernelDriver(true);
    } catch {
      // Not all platforms or backends support this.
    }

    (claimed.inEndpoint as { timeout?: number }).timeout = PROBE_TIMEOUT_MS;
    (claimed.outEndpoint as { timeout?: number }).timeout = PROBE_TIMEOUT_MS;
    claimed.usbInterface.claim();

    transport = new NodeUsbFastbootTransport(
      claimed.usbDevice,
      claimed.inEndpoint,
      claimed.outEndpoint,
      claimed.identity,
    );

    const command = Buffer.from("getvar:product", "utf8");
    const written = await transport.write(command);
    if (written !== command.byteLength) {
      throw new TransportError(
        `Short USB write: wrote ${written} of ${command.byteLength} command bytes.`,
      );
    }

    while (true) {
      const packet = Buffer.from(await transport.read(MAX_RESPONSE_BYTES)).toString("utf8");
      const kind = packet.slice(0, 4);

      switch (kind) {
        case "INFO":
        case "TEXT":
          continue;
        case "OKAY":
          return "success";
        case "FAIL":
          return "failure";
        default:
          throw new TransportError(`Unexpected Fastboot response '${packet}'.`);
      }
    }
  } catch (error) {
    return isBusyError(error) ? "busy" : "failure";
  } finally {
    if (transport !== null) {
      await transport.close();
    } else if (claimed !== null) {
      try {
        claimed.usbDevice.close();
      } catch {
        // Ignore close failures while tearing down a probe attempt.
      }
    }
  }
}

async function probeFastbootWithoutFix(serial?: string): Promise<ProbeSummary> {
  let successCount = 0;
  let failureCount = 0;

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const outcome = await runGetVarProductProbe(serial);

    switch (outcome) {
      case "success":
        successCount += 1;
        break;
      case "busy":
        break;
      case "failure":
        failureCount += 1;
        break;
    }
  }

  if (successCount === PROBE_ATTEMPTS) {
    return {
      kind: "ready",
      summary: "Fastboot probe succeeded 3/3 times without a host-side USB fix.",
      canContinue: true,
    };
  }

  if (failureCount === 0) {
    return {
      kind: "busy-only",
      summary:
        successCount > 0
          ? "Fastboot probe succeeded without a host-side USB fix, but the USB interface was busy during some attempts. Replug the device and retry if BUSY persists."
          : "Fastboot probe could not complete because the USB interface stayed busy. Replug the device and retry.",
      canContinue: successCount > 0,
    };
  }

  return {
    kind: "fix-required",
    summary: `Fastboot probe only succeeded ${successCount}/${PROBE_ATTEMPTS} times without a host-side USB fix.`,
    canContinue: false,
  };
}

function buildNoFixResult(
  platform: PlatformFix["platform"],
  summary: string,
): PlatformFix {
  return {
    platform,
    required: false,
    applied: false,
    requiresReplug: false,
    summary,
  };
}

function maybeEnableWindowsUsbDk(): void {
  if (process.platform !== "win32") {
    return;
  }

  try {
    useUsbDkBackend();
  } catch {
    // Falling back to the default backend is acceptable.
  }
}

export async function openFastbootTransport(
  options: OpenTransportOptions = {},
): Promise<OpenTransportResult> {
  maybeEnableWindowsUsbDk();

  let claimed = await findFastbootDevice(options.serial);
  let fix: PlatformFix;
  let requiresCleanReconnect = false;

  if (options.autoApplyPlatformFixes === false) {
    fix = {
      platform: getRuntimePlatform(),
      required: false,
      applied: false,
      requiresReplug: false,
      summary: "Automatic platform fixes are disabled.",
    };
  } else {
    const identity = claimed.identity;
    const reconnectSelector = identity.serialNumber ?? identity.path;

    claimed.usbDevice.close();

    const currentFix = await getPlatformFixState(identity);

    if (currentFix.required) {
      fix = currentFix;
    } else if (currentFix.platform === "linux" || currentFix.platform === "windows") {
      const probe = await probeFastbootWithoutFix(reconnectSelector);

      if (probe.kind === "ready") {
        fix = buildNoFixResult(currentFix.platform, probe.summary);
      } else if (probe.kind === "busy-only") {
        options.onPlatformFixStatus?.(probe.summary);
        if (!probe.canContinue) {
          throw new PlatformFixError(probe.summary);
        }
        requiresCleanReconnect = true;
        fix = buildNoFixResult(currentFix.platform, probe.summary);
      } else {
        options.onPlatformFixStatus?.(probe.summary);
        try {
          fix = await ensurePlatformFix(identity, options.confirmPrivilegedFix);
        } catch (error) {
          if (!(error instanceof PlatformFixDeclinedError)) {
            throw error;
          }

          options.onPlatformFixStatus?.(
            `${error.message} Continuing without the host-side USB fix.`,
          );
          requiresCleanReconnect = true;
          fix = buildNoFixResult(
            currentFix.platform,
            "Host-side USB fix was declined after probe instability; continuing without it.",
          );
        }
      }
    } else {
      fix = currentFix;
    }

    if (fix.requiresReplug) {
      options.onPlatformFixStatus?.(fix.summary);
      options.onPlatformFixStatus?.("Please unplug and replug the Fastboot device now.");

      const removed = await waitForFastbootDeviceRemoval(
        {
          serial: reconnectSelector,
          idVendor: identity.idVendor,
          idProduct: identity.idProduct,
        },
        options.reconnectTimeoutMs ?? 120_000,
      );

      if (!removed) {
        throw new PlatformFixError(
          "Platform fix was applied, but the device was not unplugged in time. Replug it and retry.",
        );
      }

      options.onPlatformFixStatus?.("Device unplug detected. Waiting for it to reconnect...");

      const reconnect = await waitForFastbootDevice(
        {
          serial: reconnectSelector,
          idVendor: identity.idVendor,
          idProduct: identity.idProduct,
        },
        options.reconnectTimeoutMs ?? 120_000,
      );

      if (reconnect === null) {
        throw new PlatformFixError(
          "Platform fix was applied, but the Fastboot device did not reappear in time after replug.",
        );
      }

      claimed = await findFastbootDevice(reconnect.serialNumber ?? reconnect.path);
      options.onPlatformFixStatus?.("Fastboot device reconnected.");
    } else if (requiresCleanReconnect) {
      options.onPlatformFixStatus?.(
        "Probe attempts may have left the device state dirty. Please unplug and replug the Fastboot device now before continuing.",
      );

      const removed = await waitForFastbootDeviceRemoval(
        {
          serial: reconnectSelector,
          idVendor: identity.idVendor,
          idProduct: identity.idProduct,
        },
        options.reconnectTimeoutMs ?? 120_000,
      );

      if (!removed) {
        throw new PlatformFixError(
          "A clean reconnect is required after the probe attempts, but the device was not unplugged in time. Replug it and retry.",
        );
      }

      options.onPlatformFixStatus?.("Device unplug detected. Waiting for it to reconnect...");

      const reconnect = await waitForFastbootDevice(
        {
          serial: reconnectSelector,
          idVendor: identity.idVendor,
          idProduct: identity.idProduct,
        },
        options.reconnectTimeoutMs ?? 120_000,
      );

      if (reconnect === null) {
        throw new PlatformFixError(
          "A clean reconnect was required after the probe attempts, but the Fastboot device did not reappear in time.",
        );
      }

      claimed = await findFastbootDevice(reconnect.serialNumber ?? reconnect.path);
      options.onPlatformFixStatus?.("Fastboot device reconnected.");
    } else {
      claimed = await findFastbootDevice(reconnectSelector);
    }
  }

  if (
    fix.platform === "darwin" &&
    fix.summary.length > 0 &&
    fix.requiresReplug === false
  ) {
    options.onPlatformFixStatus?.(fix.summary);
  }

  try {
    claimed.usbDevice.setAutoDetachKernelDriver(true);
  } catch {
    // Not all platforms or backends support this.
  }

  claimed.usbInterface.claim();

  return {
    transport: new NodeUsbFastbootTransport(
      claimed.usbDevice,
      claimed.inEndpoint,
      claimed.outEndpoint,
      claimed.identity,
    ),
    fix,
  };
}
