import {
  getDeviceList,
  type Device,
  type Endpoint,
  type Interface,
  type InEndpoint,
  type OutEndpoint,
} from "usb";

import type { FastbootDevice } from "fastboot-bun-ts/contracts/fastboot";
import { poll } from "fastboot-bun-ts/shared/async";
import { DeviceNotFoundError } from "fastboot-bun-ts/shared/errors";

const FASTBOOT_CLASS = 0xff;
const FASTBOOT_SUBCLASS = 0x42;
const FASTBOOT_PROTOCOL = 0x03;
const BULK_TRANSFER_TYPE = 2;

interface ClaimedFastbootInterface {
  readonly usbDevice: Device;
  readonly usbInterface: Interface;
  readonly inEndpoint: InEndpoint;
  readonly outEndpoint: OutEndpoint;
  readonly identity: FastbootDevice;
}

function isBulkInEndpoint(endpoint: Endpoint): endpoint is InEndpoint {
  return (
    endpoint.direction === "in" &&
    endpoint.transferType === BULK_TRANSFER_TYPE
  );
}

function isBulkOutEndpoint(endpoint: Endpoint): endpoint is OutEndpoint {
  return (
    endpoint.direction === "out" &&
    endpoint.transferType === BULK_TRANSFER_TYPE
  );
}

function buildUsbPath(device: Device): string {
  const ports = device.portNumbers?.length ? device.portNumbers.join(".") : "root";
  return `${device.busNumber}-${ports}-${device.deviceAddress}`;
}

async function getStringDescriptor(
  device: Device,
  index: number,
): Promise<string | null> {
  if (index === 0) {
    return null;
  }

  return await new Promise((resolve) => {
    device.getStringDescriptor(index, (error, value) => {
      if (error !== undefined || value === undefined) {
        resolve(null);
        return;
      }

      resolve(value);
    });
  });
}

async function buildIdentity(
  device: Device,
  usbInterface: Interface,
): Promise<FastbootDevice> {
  const { deviceDescriptor } = device;

  const [serialNumber, product, manufacturer] = await Promise.all([
    getStringDescriptor(device, deviceDescriptor.iSerialNumber),
    getStringDescriptor(device, deviceDescriptor.iProduct),
    getStringDescriptor(device, deviceDescriptor.iManufacturer),
  ]);

  return {
    idVendor: deviceDescriptor.idVendor,
    idProduct: deviceDescriptor.idProduct,
    bcdUSB: deviceDescriptor.bcdUSB,
    bcdDevice: deviceDescriptor.bcdDevice,
    serialNumber,
    product,
    manufacturer,
    interfaceNumber: usbInterface.interfaceNumber,
    path: buildUsbPath(device),
  };
}

async function inspectDevice(
  device: Device,
  requestedSerial?: string,
): Promise<ClaimedFastbootInterface | null> {
  device.open();

  try {
    for (const usbInterface of device.interfaces ?? []) {
      const descriptor = usbInterface.descriptor;
      const hasFastbootClass =
        descriptor.bInterfaceClass === FASTBOOT_CLASS &&
        descriptor.bInterfaceSubClass === FASTBOOT_SUBCLASS &&
        descriptor.bInterfaceProtocol === FASTBOOT_PROTOCOL;

      if (!hasFastbootClass) {
        continue;
      }

      const inEndpoint = usbInterface.endpoints.find(isBulkInEndpoint);
      const outEndpoint = usbInterface.endpoints.find(isBulkOutEndpoint);

      if (inEndpoint === undefined || outEndpoint === undefined) {
        continue;
      }

      const identity = await buildIdentity(device, usbInterface);
      if (
        requestedSerial !== undefined &&
        identity.serialNumber !== requestedSerial &&
        identity.path !== requestedSerial
      ) {
        continue;
      }

      return {
        usbDevice: device,
        usbInterface,
        inEndpoint,
        outEndpoint,
        identity,
      };
    }

    device.close();
    return null;
  } catch (error) {
    try {
      device.close();
    } catch {
      // Ignore close failures while probing the device.
    }

    throw error;
  }
}

export async function listFastbootDevices(): Promise<FastbootDevice[]> {
  const matches: FastbootDevice[] = [];

  for (const device of getDeviceList()) {
    try {
      const inspected = await inspectDevice(device);
      if (inspected === null) {
        continue;
      }

      matches.push(inspected.identity);
      inspected.usbDevice.close();
    } catch {
      // Ignore devices that cannot be opened or are not readable.
    }
  }

  return matches;
}

export async function findFastbootDevice(
  serial?: string,
): Promise<ClaimedFastbootInterface> {
  for (const device of getDeviceList()) {
    try {
      const match = await inspectDevice(device, serial);
      if (match !== null) {
        return match;
      }
    } catch {
      // Ignore transient device failures during enumeration.
    }
  }

  throw new DeviceNotFoundError(
    serial === undefined
      ? "No Fastboot device found."
      : `No Fastboot device matching '${serial}' was found.`,
  );
}

export async function waitForFastbootDevice(
  matcher: {
    serial?: string;
    idVendor?: number;
    idProduct?: number;
  },
  timeoutMs = 60_000,
): Promise<FastbootDevice | null> {
  return await poll(async () => {
    const devices = await listFastbootDevices();

    return (
      devices.find((device) => {
        if (
          matcher.serial !== undefined &&
          device.serialNumber !== matcher.serial &&
          device.path !== matcher.serial
        ) {
          return false;
        }

        if (
          matcher.idVendor !== undefined &&
          device.idVendor !== matcher.idVendor
        ) {
          return false;
        }

        if (
          matcher.idProduct !== undefined &&
          device.idProduct !== matcher.idProduct
        ) {
          return false;
        }

        return true;
      }) ?? null
    );
  }, { timeoutMs });
}

export async function waitForFastbootDeviceRemoval(
  matcher: {
    serial?: string;
    idVendor?: number;
    idProduct?: number;
  },
  timeoutMs = 60_000,
): Promise<boolean> {
  const removed = await poll(async () => {
    const devices = await listFastbootDevices();
    const device = devices.find((candidate) => {
      if (
        matcher.serial !== undefined &&
        candidate.serialNumber !== matcher.serial &&
        candidate.path !== matcher.serial
      ) {
        return false;
      }

      if (
        matcher.idVendor !== undefined &&
        candidate.idVendor !== matcher.idVendor
      ) {
        return false;
      }

      if (
        matcher.idProduct !== undefined &&
        candidate.idProduct !== matcher.idProduct
      ) {
        return false;
      }

      return true;
    });

    return device === undefined ? true : null;
  }, { timeoutMs, intervalMs: 250 });

  return removed ?? false;
}

export type { ClaimedFastbootInterface };
