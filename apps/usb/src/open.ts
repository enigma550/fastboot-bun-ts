import { useUsbDkBackend } from "usb";

import type { PlatformFix } from "fastboot-bun-ts/contracts/fastboot";
import { getRuntimePlatform } from "fastboot-bun-ts/shared/platform";
import {
  PlatformFixDeclinedError,
  PlatformFixError,
} from "fastboot-bun-ts/shared/errors";

import {
  findFastbootDevice,
  waitForFastbootDevice,
  waitForFastbootDeviceRemoval,
} from "./discovery";
import { NodeUsbFastbootTransport } from "./node-usb-transport";
import { ensurePlatformFix, getPlatformFixState } from "./platform-fixes";
import { assertProbeCanContinue, probeFastbootWithoutFix } from "./probe";
import type { OpenTransportOptions, OpenTransportResult } from "./types";

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
      const probe = await probeFastbootWithoutFix(options, reconnectSelector);

      if (probe.kind === "ready") {
        fix = buildNoFixResult(currentFix.platform, probe.summary);
      } else if (probe.kind === "busy-only") {
        options.onPlatformFixStatus?.(probe.summary);
        assertProbeCanContinue(probe);
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
