import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const runPowerShellDpapi = async (scriptPath, mode, inputB64) => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Mode",
        mode
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `DPAPI helper exited with code ${code}`));
      }
    });

    child.stdin.end(inputB64);
  });
};

export const getOrCreateMasterKey = async ({ appDataDir, dpapiScriptPath }) => {
  const testKey = process.env.CODEX_MANAGER_TEST_KEY_B64;
  if (testKey) {
    const key = Buffer.from(testKey, "base64");
    if (key.length !== 32) throw new Error("CODEX_MANAGER_TEST_KEY_B64 must decode to 32 bytes");
    return key;
  }

  if (process.platform !== "win32") {
    throw new Error("This build protects the vault with Windows DPAPI and is intended for Windows.");
  }

  const keyPath = path.join(appDataDir, "master-key.dpapi");

  try {
    const protectedB64 = (await fs.readFile(keyPath, "utf8")).trim();
    const clearB64 = await runPowerShellDpapi(dpapiScriptPath, "Unprotect", protectedB64);
    const key = Buffer.from(clearB64, "base64");
    if (key.length !== 32) throw new Error("Invalid decrypted master key length");
    return key;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const key = crypto.randomBytes(32);
  const protectedB64 = await runPowerShellDpapi(dpapiScriptPath, "Protect", key.toString("base64"));
  await fs.writeFile(keyPath, `${protectedB64}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
};
