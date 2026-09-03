import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VAULT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";

const emptyVault = () => ({
  version: VAULT_VERSION,
  activeAccountId: null,
  accounts: []
});

const encodeBase64Url = (value) => {
  let text = value.replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4) text += "=";
  return Buffer.from(text, "base64");
};

export const parseAuthMetadata = (authJson) => {
  try {
    const parsed = JSON.parse(authJson);
    const idToken = parsed?.tokens?.id_token;
    if (!idToken || typeof idToken !== "string") {
      return { email: null, planType: null, accountId: parsed?.tokens?.account_id ?? null };
    }

    const parts = idToken.split(".");
    if (parts.length !== 3) {
      return { email: null, planType: null, accountId: parsed?.tokens?.account_id ?? null };
    }

    const payload = JSON.parse(encodeBase64Url(parts[1]).toString("utf8"));
    const authClaim = payload?.["https://api.openai.com/auth"] ?? {};

    return {
      email: typeof payload?.email === "string" ? payload.email : null,
      planType: typeof authClaim?.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : null,
      accountId: parsed?.tokens?.account_id ?? null
    };
  } catch {
    return { email: null, planType: null, accountId: null };
  }
};

export const validateAuthJson = (authJson) => {
  const parsed = JSON.parse(authJson);
  const hasApiKey =
    typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 10;
  const hasTokens =
    typeof parsed?.tokens?.access_token === "string" &&
    typeof parsed?.tokens?.id_token === "string";

  if (!hasApiKey && !hasTokens) {
    throw new Error("auth.json inválido: não encontrei credenciais do Codex.");
  }
};

export const authFingerprint = (authJson) =>
  crypto.createHash("sha256").update(authJson, "utf8").digest("hex");

export const readVault = async (vaultPath, key) => {
  try {
    const envelope = JSON.parse(await fs.readFile(vaultPath, "utf8"));
    if (envelope.version !== VAULT_VERSION) {
      throw new Error(`Versão de vault não suportada: ${envelope.version}`);
    }

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

    const clear = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]);

    const parsed = JSON.parse(clear.toString("utf8"));
    return {
      version: VAULT_VERSION,
      activeAccountId: parsed.activeAccountId ?? null,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyVault();
    throw error;
  }
};

export const writeVault = async (vaultPath, key, data) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const clear = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = {
    version: VAULT_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  const temp = `${vaultPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, JSON.stringify(envelope), "utf8");
  await fs.rename(temp, vaultPath);
};

export const publicAccount = (account, activeId) => ({
  id: account.id,
  name: account.name,
  email: account.email,
  planType: account.planType,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
  lastActivatedAt: account.lastActivatedAt,
  source: account.source,
  isActive: account.id === activeId,
  authState: account.authState ?? "ok",
  lastAuthError: account.lastAuthError ?? null,
  limits: account.limits ?? null
});
