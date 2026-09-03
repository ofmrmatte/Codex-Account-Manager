import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
};

const spawnCodexAppServer = (codexHome) => {
  if (process.platform === "win32") {
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "& codex app-server --stdio"],
      {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
  }

  return spawn("codex", ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"]
  });
};

const callAppServer = async (codexHome, method, params) => {
  const child = spawnCodexAppServer(codexHome);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderr = "";
  let buffer = "";
  let nextId = 1;
  const waiting = new Map();

  const cleanup = () => {
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  };

  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiting.has(msg.id)) {
          const waiter = waiting.get(msg.id);
          waiting.delete(msg.id);
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
          else waiter.resolve(msg.result);
        }
      } catch {}
    }
  });

  const request = (requestMethod, requestParams) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    const message = { method: requestMethod, id };
    if (requestParams !== undefined) message.params = requestParams;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return p;
  };

  try {
    await withTimeout(
      request("initialize", {
        clientInfo: { name: "codex-account-manager-local", title: "Codex Account Manager", version: "1.2.2" }
      }),
      12000,
      "Timeout inicializando codex app-server."
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await withTimeout(request(method, params), 12000, `Timeout consultando ${method}.`);
  } catch (error) {
    if (stderr.trim()) throw new Error(`${error.message}\n${stderr.trim()}`);
    throw error;
  } finally {
    cleanup();
  }
};

const normalizeWindow = (value) => {
  if (!value || typeof value !== "object") return null;
  const usedPercent = Number(value.usedPercent ?? value.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const windowDurationMinsRaw = value.windowDurationMins ?? value.window_duration_mins ?? (Number.isFinite(Number(value.limit_window_seconds)) ? Math.ceil(Number(value.limit_window_seconds) / 60) : null);
  const resetsAtRaw = value.resetsAt ?? value.resets_at ?? value.reset_at ?? null;
  return {
    usedPercent,
    windowDurationMins: windowDurationMinsRaw == null ? null : Number(windowDurationMinsRaw),
    resetsAt: resetsAtRaw == null ? null : Number(resetsAtRaw)
  };
};

export const parseRateLimits = (result) => {
  const candidate = result?.rateLimitsByLimitId?.codex ?? result?.rate_limits_by_limit_id?.codex ?? result?.rateLimits ?? result?.rate_limits ?? result?.rate_limit ?? null;
  const primary = normalizeWindow(candidate?.primary ?? candidate?.primary_window ?? null);
  const secondary = normalizeWindow(candidate?.secondary ?? candidate?.secondary_window ?? null);
  return { primary, secondary, fetchedAt: new Date().toISOString(), source: "codex-app-server" };
};

export const readRateLimitsForAuth = async ({ accountId, authJson, runtimeDir }) => {
  const isolated = path.join(runtimeDir, `${accountId}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const authPath = path.join(isolated, "auth.json");
  await fs.mkdir(isolated, { recursive: true });
  await fs.writeFile(authPath, authJson, "utf8");
  try {
    const result = await callAppServer(isolated, "account/rateLimits/read", undefined);
    let refreshedAuthJson = authJson;
    try { refreshedAuthJson = await fs.readFile(authPath, "utf8"); } catch {}
    return { limits: parseRateLimits(result), authJson: refreshedAuthJson };
  } finally {
    await fs.rm(isolated, { recursive: true, force: true }).catch(() => {});
  }
};

export const writeActiveAuth = async ({ codexHome, authJson }) => {
  const authPath = path.join(codexHome, "auth.json");
  await fs.mkdir(codexHome, { recursive: true });
  try {
    const current = await fs.readFile(authPath, "utf8");
    await fs.writeFile(path.join(codexHome, "auth.json.bak"), current, "utf8");
  } catch {}
  const tempPath = path.join(codexHome, `auth.json.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(tempPath, authJson, "utf8");
  try {
    await fs.rm(authPath, { force: true });
    await fs.rename(tempPath, authPath);
  } catch (error) {
    try { await fs.rm(tempPath, { force: true }); } catch {}
    throw error;
  }
};

export const openCodexLogin = async ({ loginHome }) => {
  if (process.platform !== "win32") throw new Error("O fluxo assistido de login deste build e para Windows.");
  if (!loginHome) throw new Error("Home isolado de login nao informado.");
  await fs.mkdir(loginHome, { recursive: true });
  const configPath = path.join(loginHome, "config.toml");
  await fs.writeFile(configPath, 'cli_auth_credentials_store = "file"\n', "utf8");
  const scriptPath = path.join(loginHome, "Login-Isolado.ps1");
  const script = `
$ErrorActionPreference = 'Stop'
$env:CODEX_HOME = Split-Path -Parent $MyInvocation.MyCommand.Path
$Host.UI.RawUI.WindowTitle = 'Login isolado - Codex Account Manager'
Write-Host ''
Write-Host 'REAUTENTICACAO ISOLADA' -ForegroundColor Cyan
Write-Host 'Este processo nao faz logout da conta ativa do Codex Desktop.' -ForegroundColor DarkGray
Write-Host ('CODEX_HOME: ' + $env:CODEX_HOME) -ForegroundColor DarkGray
Write-Host ''
Write-Host 'O Codex exibira um endereco e um codigo temporario.' -ForegroundColor White
Write-Host 'Abra o endereco, informe o codigo e entre na conta que deseja reautenticar.' -ForegroundColor White
Write-Host ''
& codex login --device-auth
Write-Host ''
$authPath = Join-Path $env:CODEX_HOME 'auth.json'
if (Test-Path $authPath) {
  Write-Host 'LOGIN CONCLUIDO: auth.json criado no perfil isolado.' -ForegroundColor Green
  Get-Item $authPath | Select-Object FullName,Length,LastWriteTime | Format-List
  Write-Host 'Volte ao Codex Account Manager e clique em Concluir login pendente.' -ForegroundColor Green
} else {
  Write-Host 'LOGIN NAO CONCLUIDO: auth.json nao foi criado.' -ForegroundColor Red
  Write-Host 'Nao faca logout da conta ativa. Tente novamente nesta mesma janela.' -ForegroundColor Yellow
}
Write-Host ''
Read-Host 'Pressione ENTER para fechar'
`;
  await fs.writeFile(scriptPath, script, "utf8");
  const escapedScript = String(scriptPath).replaceAll("'", "''");
  const launcher = `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapedScript}')`;
  const encoded = Buffer.from(launcher, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { scriptPath, manualCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"` };
};

const runPowerShell = async (script, { detached = false, hidden = true } = {}) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { detached, stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"], windowsHide: hidden });
  if (detached) { child.unref(); return { code: 0, stdout: "", stderr: "" }; }
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  return { code: Number(code ?? 0), stdout, stderr };
};

export const isCodexDesktopRunning = async () => {
  if (process.platform !== "win32") return false;
  const ps = `
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'ChatGPT.exe' -and (
    $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*' -or
    $_.CommandLine -like '*OpenAI.Codex*'
  )
}
if ($running) { Write-Output 'RUNNING'; exit 0 }
Write-Output 'STOPPED'; exit 1
`;
  const result = await runPowerShell(ps);
  return result.code === 0 && result.stdout.includes("RUNNING");
};

export const stopCodexApp = async () => {
  if (process.platform !== "win32") throw new Error("Encerramento automático disponível apenas no Windows.");
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'ChatGPT.exe' -and (
    $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*' -or
    $_.CommandLine -like '*OpenAI.Codex*'
  )
}
foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
`;
  const result = await runPowerShell(ps);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Falha ao encerrar o Codex App.");
};

export const startCodexApp = async () => {
  if (process.platform !== "win32") throw new Error("Abertura automática disponível apenas no Windows.");
  await runPowerShell("Start-Process 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'", { detached: true, hidden: true });
};

export const restartCodexApp = async () => { await stopCodexApp(); await startCodexApp(); };

export const startManagedChatgptLogin = async ({ loginHome, onCompleted }) => {
  if (!loginHome) throw new Error("Home isolado de login nao informado.");
  await fs.mkdir(loginHome, { recursive: true });
  await fs.writeFile(path.join(loginHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");

  const child = spawnCodexAppServer(loginHome);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  let settled = false;
  let loginId = null;
  const waiting = new Map();

  const cleanup = () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} };
  const notifyCompleted = async (payload) => {
    if (settled) return;
    if (loginId && payload?.loginId && payload.loginId !== loginId) return;
    settled = true;
    try {
      await onCompleted?.({ success: Boolean(payload?.success), error: payload?.error ?? null, loginId: payload?.loginId ?? loginId });
    } finally { setTimeout(cleanup, 250); }
  };

  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiting.has(msg.id)) {
          const waiter = waiting.get(msg.id);
          waiting.delete(msg.id);
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
          else waiter.resolve(msg.result);
          continue;
        }
        if (msg.method === "account/login/completed") void notifyCompleted(msg.params ?? {});
      } catch {}
    }
  });

  child.on("error", (error) => {
    if (!settled) { settled = true; void onCompleted?.({ success: false, error: error.message, loginId }); }
  });
  child.on("close", (code) => {
    if (!settled && Number(code ?? 0) !== 0) {
      settled = true;
      const detail = stderr.trim() || `codex app-server encerrou com codigo ${code}`;
      void onCompleted?.({ success: false, error: detail, loginId });
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    const message = { method, id };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return p;
  };

  try {
    await withTimeout(request("initialize", { clientInfo: { name: "codex-account-manager-local", title: "Codex Account Manager", version: "1.2.2" } }), 12000, "Timeout inicializando login isolado do Codex.");
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await withTimeout(request("account/login/start", { type: "chatgpt" }), 15000, "Timeout iniciando login ChatGPT no app-server.");
    if (!result?.loginId || !result?.authUrl) throw new Error("O Codex nao retornou loginId/authUrl para o login ChatGPT.");
    loginId = result.loginId;
    return {
      loginId,
      authUrl: result.authUrl,
      cancel: async () => {
        if (!settled) {
          try { await withTimeout(request("account/login/cancel", { loginId }), 5000, "Timeout cancelando login."); } catch {}
        }
        settled = true;
        cleanup();
      }
    };
  } catch (error) {
    cleanup();
    if (stderr.trim()) throw new Error(`${error.message}\n${stderr.trim()}`);
    throw error;
  }
};
