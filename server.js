import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { getOrCreateMasterKey } from "./lib/dpapi.js";
import {
  authFingerprint,
  parseAuthMetadata,
  publicAccount,
  readVault,
  validateAuthJson,
  writeVault
} from "./lib/vault.js";
import {
  openCodexLogin,
  startManagedChatgptLogin,
  readRateLimitsForAuth,
  restartCodexApp,
  isCodexDesktopRunning,
  stopCodexApp,
  startCodexApp,
  writeActiveAuth
} from "./lib/codex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CODEX_ACCOUNT_MANAGER_PORT ?? 3210);
const HOST = "127.0.0.1";

const userHome = process.env.USERPROFILE || os.homedir();
const codexHome = path.join(userHome, ".codex");
const localAppData =
  process.env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");
const appDataDir =
  process.env.CODEX_ACCOUNT_MANAGER_DATA ||
  path.join(localAppData, "CodexAccountManager");
const runtimeDir = path.join(appDataDir, "runtime");
const loginRoot = path.join(appDataDir, "login");
const pendingLoginPath = path.join(appDataDir, "pending-login.json");
const vaultPath = path.join(appDataDir, "accounts.vault");
const dpapiScriptPath = path.join(__dirname, "scripts", "dpapi.ps1");
const publicDir = path.join(__dirname, "public");

await fs.mkdir(appDataDir, { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });
await fs.mkdir(loginRoot, { recursive: true });

const masterKey = await getOrCreateMasterKey({ appDataDir, dpapiScriptPath });

let managedLoginSession = null;

let mutationLock = Promise.resolve();
const withVaultMutation = async (fn) => {
  let release;
  const next = new Promise((resolve) => (release = resolve));
  const previous = mutationLock;
  mutationLock = previous.then(() => next);
  await previous;
  try {
    const vault = await readVault(vaultPath, masterKey);
    const result = await fn(vault);
    await writeVault(vaultPath, masterKey, vault);
    return result;
  } finally {
    release();
  }
};

const readCurrentAuth = async () => {
  const authPath = path.join(codexHome, "auth.json");
  const content = await fs.readFile(authPath, "utf8");
  validateAuthJson(content);
  return content;
};

const upsertAuthAccount = async ({
  authJson,
  name,
  source = "current",
  targetAccountId = null,
  setActive = false
} = {}) => {
  validateAuthJson(authJson);
  const meta = parseAuthMetadata(authJson);
  const fingerprint = authFingerprint(authJson);

  return withVaultMutation(async (vault) => {
    const now = new Date().toISOString();

    let existing =
      (targetAccountId && vault.accounts.find((a) => a.id === targetAccountId)) ||
      (meta.email &&
        vault.accounts.find(
          (a) => a.email && a.email.toLowerCase() === meta.email.toLowerCase()
        )) ||
      vault.accounts.find((a) => a.fingerprint === fingerprint);

    if (existing && targetAccountId && meta.email && existing.email &&
        existing.email.toLowerCase() !== meta.email.toLowerCase()) {
      throw new Error(`Voce entrou em ${meta.email}, mas a reautenticacao foi iniciada para ${existing.email}.`);
    }

    if (existing) {
      existing.authJson = authJson;
      existing.fingerprint = fingerprint;
      existing.email = meta.email ?? existing.email;
      existing.planType = meta.planType ?? existing.planType;
      existing.updatedAt = now;
      existing.authState = "ok";
      existing.lastAuthError = null;
      if (name?.trim()) existing.name = name.trim();
    } else {
      const baseName =
        name?.trim() ||
        (meta.email ? meta.email.split("@")[0] : `Conta ${vault.accounts.length + 1}`);

      existing = {
        id: crypto.randomUUID(),
        name: baseName,
        email: meta.email,
        planType: meta.planType,
        createdAt: now,
        updatedAt: now,
        lastActivatedAt: null,
        source,
        authJson,
        fingerprint,
        limits: null,
        authState: "ok",
        lastAuthError: null
      };
      vault.accounts.push(existing);
    }

    if (setActive) {
      vault.activeAccountId = existing.id;
      existing.lastActivatedAt = now;
    }
    return publicAccount(existing, vault.activeAccountId);
  });
};

const upsertCurrentAccount = async ({ name, source = "current" } = {}) => {
  const authJson = await readCurrentAuth();
  return upsertAuthAccount({ authJson, name, source, setActive: true });
};

const readPendingLogin = async () => {
  let pending;
  try {
    pending = JSON.parse(await fs.readFile(pendingLoginPath, "utf8"));
  } catch {
    return null;
  }

  const authPath = path.join(pending.loginHome, "auth.json");
  let ready = false;
  let email = null;
  try {
    const authJson = await fs.readFile(authPath, "utf8");
    validateAuthJson(authJson);
    email = parseAuthMetadata(authJson).email;
    ready = true;
  } catch {}

  return {
    ...pending,
    authPath,
    ready,
    email,
    status: ready ? "ready" : (pending.status || "waiting"),
    authUrl: pending.authUrl || null,
    error: pending.error || null
  };
};

const updatePendingLoginState = async (patch = {}) => {
  let current;
  try {
    current = JSON.parse(await fs.readFile(pendingLoginPath, "utf8"));
  } catch {
    return;
  }
  await fs.writeFile(
    pendingLoginPath,
    JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }),
    "utf8"
  );
};

const clearPendingLogin = async () => {
  const activeSession = managedLoginSession;
  managedLoginSession = null;
  if (activeSession?.cancel) {
    await activeSession.cancel().catch(() => {});
  }

  const pending = await readPendingLogin();
  if (pending?.loginHome) {
    await fs.rm(pending.loginHome, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(pendingLoginPath, { force: true }).catch(() => {});
};

const beginPendingLogin = async ({ accountId = null } = {}) => {
  await syncCurrentAuthIfKnown();
  await clearPendingLogin();

  const id = crypto.randomUUID();
  const loginHome = path.join(loginRoot, id);
  await fs.mkdir(loginHome, { recursive: true });

  const base = {
    id,
    accountId,
    loginHome,
    createdAt: new Date().toISOString(),
    status: "starting",
    authUrl: null,
    error: null
  };
  await fs.writeFile(pendingLoginPath, JSON.stringify(base), "utf8");

  try {
    const session = await startManagedChatgptLogin({
      loginHome,
      onCompleted: async ({ success, error, loginId }) => {
        await updatePendingLoginState({
          status: success ? "completed" : "failed",
          error: error ? String(error) : null,
          loginId: loginId || null,
          completedAt: new Date().toISOString()
        });
      }
    });

    managedLoginSession = session;
    await updatePendingLoginState({
      status: "waiting",
      loginId: session.loginId,
      authUrl: session.authUrl,
      error: null
    });

    return {
      id,
      accountId,
      loginId: session.loginId,
      authUrl: session.authUrl,
      status: "waiting"
    };
  } catch (error) {
    await updatePendingLoginState({ status: "failed", error: String(error.message || error) });
    throw error;
  }
};

const importPendingLogin = async ({ name = null } = {}) => {
  const pending = await readPendingLogin();
  if (!pending) throw new Error("Nenhum login isolado pendente.");
  if (!pending.ready) throw new Error("O login ainda nao foi concluido.");

  const authJson = await fs.readFile(pending.authPath, "utf8");
  const account = await upsertAuthAccount({
    authJson,
    name,
    source: pending.accountId ? "reauth-isolated" : "isolated-login",
    targetAccountId: pending.accountId,
    setActive: false
  });

  await clearPendingLogin();
  return account;
};

const isRevokedAuthError = (error) =>
  /token_revoked|invalidated oauth token/i.test(String(error?.message ?? error));

const markAccountNeedsReauth = async (accountId, error) => {
  await withVaultMutation(async (vault) => {
    const account = vault.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.authState = "reauth_required";
    account.lastAuthError = isRevokedAuthError(error) ? "token_revoked" : "auth_error";
    account.updatedAt = new Date().toISOString();
  });
};

const refreshStoredAccount = async (account, { propagateToActiveFile = false } = {}) => {
  const prepared = await readRateLimitsForAuth({
    accountId: account.id,
    authJson: account.authJson,
    runtimeDir
  });
  validateAuthJson(prepared.authJson);

  await withVaultMutation(async (fresh) => {
    const found = fresh.accounts.find((a) => a.id === account.id);
    if (!found) return;
    const meta = parseAuthMetadata(prepared.authJson);
    found.authJson = prepared.authJson;
    found.fingerprint = authFingerprint(prepared.authJson);
    found.email = meta.email ?? found.email;
    found.planType = meta.planType ?? found.planType;
    found.limits = prepared.limits;
    found.authState = "ok";
    found.lastAuthError = null;
    found.updatedAt = new Date().toISOString();
  });

  if (propagateToActiveFile) {
    await writeActiveAuth({ codexHome, authJson: prepared.authJson });
  }

  return prepared;
};

const syncCurrentAuthIfKnown = async () => {
  try {
    const authJson = await readCurrentAuth();
    const meta = parseAuthMetadata(authJson);
    const fp = authFingerprint(authJson);

    await withVaultMutation(async (vault) => {
      const match =
        (meta.email &&
          vault.accounts.find(
            (a) => a.email && a.email.toLowerCase() === meta.email.toLowerCase()
          )) ||
        vault.accounts.find((a) => a.fingerprint === fp);

      if (!match) return;

      match.authJson = authJson;
      match.fingerprint = fp;
      match.email = meta.email ?? match.email;
      match.planType = meta.planType ?? match.planType;
      match.updatedAt = new Date().toISOString();
      vault.activeAccountId = match.id;
    });
  } catch {}
};

const recoverLegacyRuntimeAuths = async () => {
  let dirs = [];
  try {
    dirs = await fs.readdir(runtimeDir, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = [];
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const authPath = path.join(runtimeDir, dirent.name, "auth.json");
    try {
      const authJson = await fs.readFile(authPath, "utf8");
      validateAuthJson(authJson);
      const stat = await fs.stat(authPath);
      const meta = parseAuthMetadata(authJson);
      candidates.push({ authPath, authJson, meta, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const recoveredPaths = [];

  await withVaultMutation(async (vault) => {
    for (const candidate of candidates) {
      const match =
        (candidate.meta.email &&
          vault.accounts.find(
            (a) => a.email && a.email.toLowerCase() === candidate.meta.email.toLowerCase()
          )) ||
        null;
      if (!match) continue;

      const existingUpdatedMs = Date.parse(match.updatedAt || 0) || 0;
      if (candidate.mtimeMs + 1000 < existingUpdatedMs) continue;

      match.authJson = candidate.authJson;
      match.fingerprint = authFingerprint(candidate.authJson);
      match.email = candidate.meta.email ?? match.email;
      match.planType = candidate.meta.planType ?? match.planType;
      match.updatedAt = new Date(candidate.mtimeMs).toISOString();
      recoveredPaths.push(candidate.authPath);
    }
  });

  try {
    await readCurrentAuth();
  } catch {
    const vault = await readVault(vaultPath, masterKey);
    const active = vault.accounts.find((a) => a.id === vault.activeAccountId);
    if (active?.authJson) {
      await writeActiveAuth({ codexHome, authJson: active.authJson });
    }
  }

  for (const authPath of recoveredPaths) {
    await fs.rm(path.dirname(authPath), { recursive: true, force: true }).catch(() => {});
  }
};

const autoImportOnFirstRun = async () => {
  const vault = await readVault(vaultPath, masterKey);
  if (vault.accounts.length > 0) return;

  try {
    await upsertCurrentAccount({ name: "Principal", source: "auto" });
  } catch {}
};

await recoverLegacyRuntimeAuths();
await autoImportOnFirstRun();

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:;"
  });
  res.end(payload);
};

const readBody = async (req) => {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 128) throw new Error("Request muito grande.");
  }
  if (!data) return {};
  return JSON.parse(data);
};

const serveStatic = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!["index.html", "app.js", "styles.css"].includes(relative)) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const full = path.join(publicDir, relative);
  const content = await fs.readFile(full);
  const type =
    relative.endsWith(".html")
      ? "text/html; charset=utf-8"
      : relative.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(content);
};

const handleApi = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/status") {
    await syncCurrentAuthIfKnown();
    const vault = await readVault(vaultPath, masterKey);
    let current = null;
    try {
      const authJson = await readCurrentAuth();
      const meta = parseAuthMetadata(authJson);
      current = {
        email: meta.email,
        planType: meta.planType,
        fingerprint: authFingerprint(authJson).slice(0, 12)
      };
    } catch {}

    const pendingLogin = await readPendingLogin();

    return json(res, 200, {
      ok: true,
      codexHome,
      appDataDir,
      activeAccountId: vault.activeAccountId,
      current,
      accountCount: vault.accounts.length,
      pendingLogin: pendingLogin ? {
        id: pendingLogin.id,
        accountId: pendingLogin.accountId,
        ready: pendingLogin.ready,
        email: pendingLogin.email,
        status: pendingLogin.status,
        authUrl: pendingLogin.authUrl,
        error: pendingLogin.error
      } : null
    });
  }

  if (req.method === "GET" && pathname === "/api/accounts") {
    await syncCurrentAuthIfKnown();
    const vault = await readVault(vaultPath, masterKey);
    return json(res, 200, {
      accounts: vault.accounts.map((a) => publicAccount(a, vault.activeAccountId))
    });
  }

  if (req.method === "POST" && pathname === "/api/accounts/import-current") {
    const body = await readBody(req);
    const pending = await readPendingLogin();
    const account = pending?.ready
      ? await importPendingLogin({ name: body.name ?? null })
      : await upsertCurrentAccount({ name: body.name ?? null, source: "current" });
    return json(res, 200, { account, importedPendingLogin: Boolean(pending?.ready) });
  }

  if (req.method === "GET" && pathname === "/api/login/pending") {
    const pending = await readPendingLogin();
    return json(res, 200, {
      pending: pending ? {
        id: pending.id,
        accountId: pending.accountId,
        ready: pending.ready,
        email: pending.email,
        status: pending.status,
        authUrl: pending.authUrl,
        error: pending.error
      } : null
    });
  }

  if (req.method === "POST" && pathname === "/api/login/open") {
    const pending = await beginPendingLogin({ accountId: null });
    return json(res, 200, { ok: true, pending });
  }

  if (req.method === "POST" && pathname === "/api/login/cancel") {
    await clearPendingLogin();
    return json(res, 200, { ok: true });
  }

  const reauthMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/reauth$/);
  if (req.method === "POST" && reauthMatch) {
    const accountId = decodeURIComponent(reauthMatch[1]);
    const vault = await readVault(vaultPath, masterKey);
    if (!vault.accounts.some((a) => a.id === accountId)) {
      return json(res, 404, { error: "Conta nao encontrada." });
    }
    const pending = await beginPendingLogin({ accountId });
    return json(res, 200, { ok: true, pending });
  }

  const activateMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/activate$/);
  if (req.method === "POST" && activateMatch) {
    const accountId = decodeURIComponent(activateMatch[1]);
    const body = await readBody(req);

    await syncCurrentAuthIfKnown();

    let vault = await readVault(vaultPath, masterKey);
    let account = vault.accounts.find((a) => a.id === accountId);
    if (!account) return json(res, 404, { error: "Conta não encontrada." });

    let prepared;
    try {
      prepared = await refreshStoredAccount(account);
    } catch (error) {
      if (isRevokedAuthError(error)) {
        await markAccountNeedsReauth(accountId, error);
        return json(res, 409, {
          code: "REAUTH_REQUIRED",
          error: "A sessao desta conta expirou. Clique em Reautenticar e faca o login novamente."
        });
      }
      return json(res, 409, {
        error: `Nao foi possivel validar esta conta antes da troca: ${String(error.message).split("\n")[0]}`
      });
    }

    const wasRunning = await isCodexDesktopRunning();
    if (wasRunning && body.restartCodex !== true) {
      return json(res, 409, {
        error: "O Codex App está aberto. Marque ‘Reiniciar Codex ao ativar’ para trocar sem disputar o token da sessão."
      });
    }

    if (wasRunning) await stopCodexApp();

    const previousActiveId = vault.activeAccountId;
    if (previousActiveId && previousActiveId !== accountId) {
      try {
        const latestVault = await readVault(vaultPath, masterKey);
        const previous = latestVault.accounts.find((a) => a.id === previousActiveId);
        if (previous) await refreshStoredAccount(previous);
      } catch (error) {
        if (isRevokedAuthError(error)) {
          await markAccountNeedsReauth(previousActiveId, error);
        }
      }
    }

    try {
      await writeActiveAuth({ codexHome, authJson: prepared.authJson });

      await withVaultMutation(async (fresh) => {
        const found = fresh.accounts.find((a) => a.id === accountId);
        if (!found) return;
        const meta = parseAuthMetadata(prepared.authJson);
        found.authJson = prepared.authJson;
        found.fingerprint = authFingerprint(prepared.authJson);
        found.email = meta.email ?? found.email;
        found.planType = meta.planType ?? found.planType;
        found.limits = prepared.limits;
        found.authState = "ok";
        found.lastAuthError = null;
        found.updatedAt = new Date().toISOString();
        found.lastActivatedAt = new Date().toISOString();
        fresh.activeAccountId = accountId;
      });
    } catch (error) {
      if (wasRunning) await startCodexApp().catch(() => {});
      throw error;
    }

    if (wasRunning || body.restartCodex === true) {
      await startCodexApp();
    }

    return json(res, 200, {
      ok: true,
      verified: true,
      verification: prepared.limits,
      restartTriggered: wasRunning || body.restartCodex === true
    });
  }

  const renameMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/rename$/);
  if (req.method === "POST" && renameMatch) {
    const accountId = decodeURIComponent(renameMatch[1]);
    const body = await readBody(req);
    const name = String(body.name ?? "").trim();
    if (!name) return json(res, 400, { error: "Nome inválido." });

    await withVaultMutation(async (vault) => {
      const account = vault.accounts.find((a) => a.id === accountId);
      if (!account) throw new Error("Conta não encontrada.");
      account.name = name;
      account.updatedAt = new Date().toISOString();
    });

    return json(res, 200, { ok: true });
  }

  const deleteMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const accountId = decodeURIComponent(deleteMatch[1]);

    await withVaultMutation(async (vault) => {
      if (vault.activeAccountId === accountId) {
        throw new Error("Não remova a conta ativa. Ative outra conta primeiro.");
      }
      vault.accounts = vault.accounts.filter((a) => a.id !== accountId);
    });

    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/limits/refresh") {
    const body = await readBody(req);
    const mode = body.mode === "background" ? "background" : "manual";

    await syncCurrentAuthIfKnown();
    const vault = await readVault(vaultPath, masterKey);
    const desktopRunning = await isCodexDesktopRunning();
    const results = [];

    for (const account of vault.accounts) {
      const isActive = vault.activeAccountId === account.id;

      if (isActive && desktopRunning) {
        results.push({
          id: account.id,
          ok: true,
          skipped: true,
          limits: account.limits,
          note: "Conta ativa preservada enquanto o Codex Desktop esta aberto. Ela sera atualizada ao trocar de conta."
        });
        continue;
      }

      try {
        const prepared = await refreshStoredAccount(account, {
          propagateToActiveFile: isActive && !desktopRunning
        });
        results.push({ id: account.id, ok: true, limits: prepared.limits });
      } catch (error) {
        if (isRevokedAuthError(error)) {
          await markAccountNeedsReauth(account.id, error);
          results.push({
            id: account.id,
            ok: false,
            code: "REAUTH_REQUIRED",
            error: "Sessao expirada."
          });
        } else {
          results.push({
            id: account.id,
            ok: false,
            error: String(error.message).split("\n")[0]
          });
        }
      }
    }

    return json(res, 200, {
      results,
      mode,
      desktopRunning,
      desktopRestarted: false
    });
  }

  if (req.method === "POST" && pathname === "/api/codex/restart") {
    await restartCodexApp();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/shutdown") {
    json(res, 200, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 100);
    return;
  }

  return json(res, 404, { error: "Endpoint não encontrado." });
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Account Manager: http://${HOST}:${PORT}`);
});

const openBrowser = () => {
  if (process.env.CODEX_ACCOUNT_MANAGER_NO_BROWSER === "1") return;

  const url = `http://${HOST}:${PORT}`;
  if (process.platform === "win32") {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  }
};

setTimeout(openBrowser, 300);
