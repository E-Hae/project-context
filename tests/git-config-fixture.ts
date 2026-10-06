import path from "node:path";

const HOME_VARIABLES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;

/**
 * Runs with the home and XDG config directories pointed at `home`, so the
 * developer's own global Git excludes file cannot change what a test sees.
 */
export async function withGitConfigHome<T>(
  home: string,
  run: () => Promise<T>,
  xdgConfigHome = path.join(home, ".config"),
): Promise<T> {
  const previous = HOME_VARIABLES.map((name) => process.env[name]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    return await run();
  } finally {
    HOME_VARIABLES.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}
