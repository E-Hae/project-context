/**
 * Runs `run` with `os.homedir()` pinned to `home` through the environment
 * variable it reads (USERPROFILE on Windows, HOME elsewhere).
 */
export async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[key];
  process.env[key] = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}
