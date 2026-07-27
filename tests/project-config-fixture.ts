import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROJECT_CONFIG_RELATIVE_PATH } from "../src/config.js";

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
}

export async function writeProjectConfig(
  projectRoot: string,
  contents: string,
): Promise<void> {
  const configPath = projectConfigPath(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, contents, "utf8");
}
