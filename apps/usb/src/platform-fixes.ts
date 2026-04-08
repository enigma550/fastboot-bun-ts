import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastbootDevice, PlatformFix } from "fastboot-bun-ts/contracts/fastboot";
import { PlatformFixDeclinedError, PlatformFixError } from "fastboot-bun-ts/shared/errors";
import { formatUsbId, formatUsbRevision } from "fastboot-bun-ts/shared/hex";
import { getRuntimePlatform } from "fastboot-bun-ts/shared/platform";
import {
  runCommand,
  runCommandWithInput,
} from "fastboot-bun-ts/shared/process";

const LINUX_QUIRKS_PATH = "/sys/module/usbcore/parameters/quirks";
const WINDOWS_VALUE_NAMES = [
  "osvc",
  "SkipContainerIdQuery",
  "SkipBOSDescriptorQuery",
] as const;
const WINDOWS_REGISTRY_VALUES = [
  { name: "osvc", data: [0x00, 0x00] },
  { name: "SkipContainerIdQuery", data: [0x01, 0x00, 0x00, 0x00] },
  { name: "SkipBOSDescriptorQuery", data: [0x01, 0x00, 0x00, 0x00] },
] as const;

function notRequired(platform: PlatformFix["platform"], summary: string): PlatformFix {
  return {
    platform,
    required: false,
    applied: false,
    requiresReplug: false,
    summary,
  };
}

function alreadyReady(platform: PlatformFix["platform"], summary: string): PlatformFix {
  return {
    platform,
    required: true,
    applied: false,
    requiresReplug: false,
    summary,
  };
}

function applied(platform: PlatformFix["platform"], summary: string): PlatformFix {
  return {
    platform,
    required: true,
    applied: true,
    requiresReplug: true,
    summary,
  };
}

function buildLinuxEntry(device: FastbootDevice): string {
  return `${formatUsbId(device.idVendor)}:${formatUsbId(device.idProduct)}:ki`;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powerShellEscape(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function writeLinuxQuirkPrivileged(nextValue: string): Promise<void> {
  const shellCommand = `cat > ${shellEscape(LINUX_QUIRKS_PATH)}`;

  const pkexecResult = await runCommandWithInput(
    "pkexec",
    ["/bin/sh", "-lc", shellCommand],
    nextValue,
  );

  if (pkexecResult.exitCode === 0) {
    return;
  }

  const sudoResult = await runCommandWithInput(
    "sudo",
    ["/bin/sh", "-lc", shellCommand],
    nextValue,
  );

  if (sudoResult.exitCode === 0) {
    return;
  }

  throw new PlatformFixError(
    [
      `Linux quirk write requires elevated privileges, but both pkexec and sudo failed.`,
      pkexecResult.stderr.trim(),
      sudoResult.stderr.trim(),
    ]
      .filter((part) => part.length > 0)
      .join(" "),
  );
}

async function getLinuxFixState(device: FastbootDevice): Promise<PlatformFix> {
  const entry = buildLinuxEntry(device);
  const current = (await readFile(LINUX_QUIRKS_PATH, "utf8")).trim();
  const present = current.split(",").includes(entry);

  if (present) {
    return alreadyReady("linux", `Linux usbcore quirk '${entry}' is already configured.`);
  }

  return notRequired("linux", `Linux usbcore quirk '${entry}' is not configured.`);
}

async function ensureLinuxFix(
  device: FastbootDevice,
  confirmPrivilegedFix?: (message: string) => Promise<boolean>,
): Promise<PlatformFix> {
  const entry = buildLinuxEntry(device);
  const current = (await readFile(LINUX_QUIRKS_PATH, "utf8")).trim();

  const approved = await confirmPrivilegedFix?.(
    `Fastboot detected that Linux host fix '${entry}' is required for this device. Applying it needs root/admin rights and will write to '${LINUX_QUIRKS_PATH}'. Allow this auto-fix?`,
  ) ?? false;

  if (!approved) {
    throw new PlatformFixDeclinedError(
      `Linux quirk '${entry}' is required. Auto-fix was not approved. Re-run and approve the admin/root prompt, use '--no-auto-fix', or write '${entry}' into '${LINUX_QUIRKS_PATH}' manually.`,
    );
  }

  const nextValue = current.length > 0 ? `${current},${entry}` : entry;

  try {
    await access(LINUX_QUIRKS_PATH, fsConstants.W_OK);
    await writeFile(LINUX_QUIRKS_PATH, nextValue, "utf8");
  } catch (error) {
    try {
      await writeLinuxQuirkPrivileged(nextValue);
    } catch (privilegedError) {
      throw new PlatformFixError(
        `Linux quirk '${entry}' is required, but '${LINUX_QUIRKS_PATH}' is not writable and privileged auto-fix failed.`,
        { cause: privilegedError ?? error },
      );
    }
  }

  return applied("linux", `Applied Linux usbcore quirk '${entry}'. Replug the device.`);
}

function buildWindowsRegistryKey(device: FastbootDevice): string {
  return `HKLM\\SYSTEM\\CurrentControlSet\\Control\\usbflags\\${formatUsbId(device.idVendor).toUpperCase()}${formatUsbId(device.idProduct).toUpperCase()}${formatUsbRevision(device.bcdDevice).toUpperCase()}`;
}

async function queryWindowsValue(
  key: string,
  valueName: string,
): Promise<boolean> {
  const result = await runCommand("reg.exe", ["query", key, "/v", valueName]);
  return result.exitCode === 0;
}

async function addWindowsValue(
  key: string,
  valueName: string,
  value: string,
): Promise<boolean> {
  const result = await runCommand("reg.exe", [
    "add",
    key,
    "/v",
    valueName,
    "/t",
    "REG_BINARY",
    "/d",
    value,
    "/f",
  ]);

  return result.exitCode === 0;
}

function buildWindowsPowerShellKey(key: string): string {
  return key.replace(/^HKLM\\/, "Registry::HKEY_LOCAL_MACHINE\\");
}

function buildWindowsFixScript(key: string): string {
  const registryKey = buildWindowsPowerShellKey(key);
  const writes = WINDOWS_REGISTRY_VALUES.map(({ name, data }) => {
    const byteList = data.map((byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ");
    return `New-ItemProperty -Path ${powerShellEscape(registryKey)} -Name ${powerShellEscape(name)} -PropertyType Binary -Value ([byte[]](${byteList})) -Force | Out-Null`;
  }).join("\n");

  return [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -Path ${powerShellEscape(registryKey)} -Force | Out-Null`,
    writes,
  ].join("\n");
}

async function applyWindowsFixPrivileged(key: string): Promise<void> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "fastboot-bun-ts-"));
  const scriptPath = join(tempDirectory, "apply-usbflags.ps1");
  const script = buildWindowsFixScript(key);

  try {
    await writeFile(scriptPath, script, "utf8");

    const argumentList = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]
      .map((part) => powerShellEscape(part))
      .join(", ");

    const result = await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(${argumentList}); exit $process.ExitCode`,
    ]);

    if (result.exitCode !== 0) {
      throw new PlatformFixError(
        `Failed to apply Windows usbflags under '${key}' with UAC elevation: ${result.stderr || result.stdout}`.trim(),
      );
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function ensureWindowsFix(
  device: FastbootDevice,
  confirmPrivilegedFix?: (message: string) => Promise<boolean>,
): Promise<PlatformFix> {
  const key = buildWindowsRegistryKey(device);
  const present = await Promise.all(
    WINDOWS_VALUE_NAMES.map(async (valueName) => await queryWindowsValue(key, valueName)),
  );

  if (present.every(Boolean)) {
    return alreadyReady("windows", `Windows usbflags for '${key}' are already configured.`);
  }

  const approved = await confirmPrivilegedFix?.(
    `Fastboot detected that Windows host usbflags are required for this device. Applying them needs administrator rights and will write under '${key}'. Allow this auto-fix?`,
  ) ?? false;

  if (!approved) {
    throw new PlatformFixDeclinedError(
      `Windows usbflags under '${key}' are required. Auto-fix was not approved. Re-run and approve the admin prompt, use '--no-auto-fix', or apply the documented registry values manually.`,
    );
  }

  const directWriteSucceeded = (
    await Promise.all([
      addWindowsValue(key, "osvc", "0000"),
      addWindowsValue(key, "SkipContainerIdQuery", "01000000"),
      addWindowsValue(key, "SkipBOSDescriptorQuery", "01000000"),
    ])
  ).every(Boolean);

  if (!directWriteSucceeded) {
    await applyWindowsFixPrivileged(key);
  }

  return applied("windows", `Applied Windows usbflags under '${key}'. Replug the device.`);
}

async function getWindowsFixState(device: FastbootDevice): Promise<PlatformFix> {
  const key = buildWindowsRegistryKey(device);
  const present = await Promise.all(
    WINDOWS_VALUE_NAMES.map(async (valueName) => await queryWindowsValue(key, valueName)),
  );

  if (present.every(Boolean)) {
    return alreadyReady("windows", `Windows usbflags for '${key}' are already configured.`);
  }
  return notRequired("windows", `Windows usbflags for '${key}' are not configured.`);
}

export async function getPlatformFixState(
  device: FastbootDevice,
): Promise<PlatformFix> {
  const platform = getRuntimePlatform();

  switch (platform) {
    case "linux":
      return await getLinuxFixState(device);
    case "windows":
      return await getWindowsFixState(device);
    case "darwin":
      return notRequired(
        "darwin",
        "macOS cannot apply a host-side Fastboot USB fix. If the device hangs, reconnect it through a USB 2.0 hub.",
      );
    default:
      return notRequired("unknown", "Unsupported host platform; no automatic host fix available.");
  }
}

export async function ensurePlatformFix(
  device: FastbootDevice,
  confirmPrivilegedFix?: (message: string) => Promise<boolean>,
): Promise<PlatformFix> {
  const platform = getRuntimePlatform();

  switch (platform) {
    case "linux":
      return await ensureLinuxFix(device, confirmPrivilegedFix);
    case "windows":
      return await ensureWindowsFix(device, confirmPrivilegedFix);
    case "darwin":
      return notRequired(
        "darwin",
        "macOS cannot apply a host-side Fastboot USB fix. If the device hangs, reconnect it through a USB 2.0 hub.",
      );
    default:
      return notRequired("unknown", "Unsupported host platform; no automatic host fix available.");
  }
}
