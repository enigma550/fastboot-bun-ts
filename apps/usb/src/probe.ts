import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "fastboot-bun-ts/shared/process";

import { PlatformFixError } from "fastboot-bun-ts/shared/errors";

import type { OpenTransportOptions } from "./types";

const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CLI_PATH = fileURLToPath(
  new URL("../../fastboot/src/cli.ts", import.meta.url),
);
const PROBE_SERIAL_ENV = "FASTBOOT_BUN_TS_PROBE_SERIAL";

const FASTBOOT_PROBE_EVAL_SCRIPT = `
import { Buffer } from "node:buffer";
import { getDeviceList } from "usb";

const FASTBOOT_CLASS = 0xff;
const FASTBOOT_SUBCLASS = 0x42;
const FASTBOOT_PROTOCOL = 0x03;
const BULK_TRANSFER_TYPE = 2;
const MAX_RESPONSE_BYTES = 256;
const requestedSerial = process.env.FASTBOOT_BUN_TS_PROBE_SERIAL || undefined;

function isBulkInEndpoint(endpoint) {
  return endpoint.direction === "in" && endpoint.transferType === BULK_TRANSFER_TYPE;
}

function isBulkOutEndpoint(endpoint) {
  return endpoint.direction === "out" && endpoint.transferType === BULK_TRANSFER_TYPE;
}

function buildUsbPath(device) {
  const ports = device.portNumbers?.length ? device.portNumbers.join(".") : "root";
  return String(device.busNumber) + "-" + ports + "-" + String(device.deviceAddress);
}

async function getStringDescriptor(device, index) {
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

async function findFastbootInterface() {
  for (const device of getDeviceList()) {
    let opened = false;

    try {
      device.open();
      opened = true;

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

        const serialNumber = await getStringDescriptor(
          device,
          device.deviceDescriptor.iSerialNumber,
        );
        const path = buildUsbPath(device);

        if (
          requestedSerial !== undefined &&
          serialNumber !== requestedSerial &&
          path !== requestedSerial
        ) {
          continue;
        }

        return { device, usbInterface, inEndpoint, outEndpoint };
      }
    } catch (error) {
      if (opened) {
        try {
          device.close();
        } catch {
          // Ignore close failures while probing.
        }
      }

      // Ignore per-device USB access/open failures and continue probing
      // other Fastboot-capable devices, matching the normal discovery path.
      continue;
    }

    if (opened) {
      try {
        device.close();
      } catch {
        // Ignore close failures while probing.
      }
    }
  }

  throw new Error(
    requestedSerial === undefined
      ? "No Fastboot device found."
      : "No Fastboot device matching '" + requestedSerial + "' was found.",
  );
}

function parsePacket(data) {
  const message = Buffer.from(data).toString("utf8");
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
      throw new Error("Unexpected Fastboot response '" + message + "'.");
  }
}

async function readTerminalResponse(inEndpoint) {
  while (true) {
    const packet = parsePacket(await inEndpoint.transferAsync(MAX_RESPONSE_BYTES));

    switch (packet.kind) {
      case "INFO":
      case "TEXT":
        continue;
      case "OKAY":
      case "DATA":
        return packet.payload;
      case "FAIL":
        throw new Error("Fastboot failed: " + packet.payload);
    }
  }
}

async function main() {
  const claimed = await findFastbootInterface();

  try {
    try {
      claimed.device.setAutoDetachKernelDriver(true);
    } catch {
      // Not all platforms support this.
    }

    claimed.usbInterface.claim();

    const command = Buffer.from("getvar:product", "utf8");
    const written = await claimed.outEndpoint.transferAsync(command);
    if (written !== command.byteLength) {
      throw new Error(
        "Short USB write: wrote " +
          String(written) +
          " of " +
          String(command.byteLength) +
          " command bytes.",
      );
    }

    const payload = await readTerminalResponse(claimed.inEndpoint);
    process.stdout.write(payload);
  } finally {
    try {
      await new Promise((resolve) => {
        claimed.device.interface(claimed.usbInterface.interfaceNumber).release(
          true,
          () => resolve(undefined),
        );
      });
    } catch {
      // Ignore release failures during shutdown.
    }

    try {
      claimed.device.close();
    } catch {
      // Ignore close failures during shutdown.
    }
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

type ProbeOutcome = "success" | "busy" | "failure";

export interface ProbeSummary {
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

function isBunExecutable(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.endsWith("/bun") ||
    normalized.endsWith("\\bun.exe") ||
    normalized.endsWith("/bun.exe") ||
    normalized === "bun" ||
    normalized === "bun.exe";
}

function findUsbModuleWorkingDirectory(startPath: string): string | undefined {
  let current = startPath;

  while (true) {
    if (existsSync(join(current, "node_modules", "usb"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function resolveProbeWorkingDirectory(explicitCwd?: string): string | undefined {
  if (explicitCwd !== undefined) {
    return explicitCwd;
  }

  const candidates = [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ];

  for (const candidate of candidates) {
    const resolved = findUsbModuleWorkingDirectory(candidate);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  return undefined;
}

function resolveProbeProcess(
  options: OpenTransportOptions,
): {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
} {
  if (options.probeProcess !== undefined) {
    return {
      command: options.probeProcess.command,
      args: options.probeProcess.args ?? [],
      cwd: options.probeProcess.cwd,
      env: options.probeProcess.env,
    };
  }

  const bunExecutable = Bun.which("bun") ?? process.execPath;
  return {
    command: bunExecutable,
    args: ["run"],
    cwd: undefined,
    env: undefined,
  };
}

function buildScriptProbeInvocation(
  options: OpenTransportOptions,
  serial?: string,
): {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
} {
  const probeProcess = resolveProbeProcess(options);
  const args = [...probeProcess.args, PROBE_CLI_PATH, "getvar", "product", "--no-auto-fix"];
  if (serial !== undefined) {
    args.push("--serial", serial);
  }

  return {
    command: probeProcess.command,
    args,
    cwd: probeProcess.cwd,
    env: probeProcess.env,
  };
}

function buildEvalProbeInvocation(
  options: OpenTransportOptions,
  serial?: string,
): {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
} {
  const probeProcess = resolveProbeProcess(options);
  const bunCommand = isBunExecutable(probeProcess.command)
    ? probeProcess.command
    : (Bun.which("bun") ?? probeProcess.command);

  const env = { ...probeProcess.env };
  if (serial !== undefined) {
    env[PROBE_SERIAL_ENV] = serial;
  }

  return {
    command: bunCommand,
    args: ["-e", FASTBOOT_PROBE_EVAL_SCRIPT],
    cwd: resolveProbeWorkingDirectory(probeProcess.cwd),
    env,
  };
}

async function runGetVarProductProbe(
  options: OpenTransportOptions,
  serial?: string,
): Promise<ProbeOutcome> {
  const invocation = existsSync(PROBE_CLI_PATH)
    ? buildScriptProbeInvocation(options, serial)
    : buildEvalProbeInvocation(options, serial);

  const result = await runCommand(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (result.exitCode === 0) {
    return "success";
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (isBusyError(new Error(output))) {
    return "busy";
  }

  return "failure";
}

export async function probeFastbootWithoutFix(
  options: OpenTransportOptions,
  serial?: string,
): Promise<ProbeSummary> {
  let successCount = 0;
  let failureCount = 0;

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const outcome = await runGetVarProductProbe(options, serial);

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

export function assertProbeCanContinue(summary: ProbeSummary): void {
  if (!summary.canContinue) {
    throw new PlatformFixError(summary.summary);
  }
}
