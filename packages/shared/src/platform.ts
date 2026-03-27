export type RuntimePlatform = "linux" | "windows" | "darwin" | "unknown";

export function getRuntimePlatform(): RuntimePlatform {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "unknown";
  }
}
