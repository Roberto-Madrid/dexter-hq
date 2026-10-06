// The bundle script replaces this module with the role sheet and crew files.
// Source keeps the null fallback so tests still read the files from disk.

export function bundledRoleSheet(): string | null {
  return null;
}

export function bundledCrews(): Record<string, string> | null {
  return null;
}

export function bundledPersonas(): Record<string, string> | null {
  return null;
}
