const $ = (selector) => document.querySelector(selector);
const accountsEl = $("#accounts");
const summaryEl = $("#accountSummary");
const toastEl = $("#toast");
const restartToggle = $("#restartToggle");
const loginPanelEl = $("#loginPanel");
const loginPanelTitleEl = $("#loginPanelTitle");
const loginPanelMessageEl = $("#loginPanelMessage");
const loginLinkEl = $("#loginLink");
const finishLoginBtn = $("#finishLoginBtn");
const cancelLoginBtn = $("#cancelLoginBtn");

let toastTimer = null;
let currentAuthPresent = false;
let pendingLogin = null;
let backgroundRefreshRunning = false;
const toast = (message, error = false) => {
  toastEl.textContent = message;
  toastEl.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 5000);
};

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};

const formatReset = (unix) => {
  if (!unix) return "reset não informado";
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return "reset não informado";
  return `reset ${date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
};

const formatFetchedAt = (iso) => {
  if (!iso) return "ainda não atualizado";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "ainda não atualizado";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return "atualizado agora";
  if (seconds < 60) return `atualizado há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `atualizado há ${minutes} min`;
  return `atualizado ${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
};

const windowLabel = (window) => {
  const mins = Number(window?.windowDurationMins);
  if (!Number.isFinite(mins)) return "Janela";
  if (mins >= 10000) return "Semanal";
  if (mins >= 280 && mins <= 320) return "5 horas";
  if (mins >= 60) return `${Math.round(mins / 60)} horas`;
  return `${mins} min`;
};

const limitHtml = (window) => {
  if (!window) return "";
  const used = Math.max(0, Math.min(100, Number(window.usedPercent || 0)));
  return `
    <div class="limit">
      <div class="limitHeader">
        <span>${windowLabel(window)}</span>
        <span>${used.toFixed(0)}% usado</span>
      </div>
      <div class="track"><div class="fill" style="width:${used}%"></div></div>
      <div class="limitMeta">${formatReset(window.resetsAt)}</div>
    </div>
  `;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderPendingLogin = () => {
  if (!pendingLogin) {
    loginPanelEl.hidden = true;
    loginLinkEl.removeAttribute("href");
    finishLoginBtn.hidden = true;
    return;
  }

  loginPanelEl.hidden = false;
  const status = pendingLogin.status || (pendingLogin.ready ? "ready" : "waiting");

  if (pendingLogin.ready) {
    loginPanelTitleEl.textContent = "Login concluído";
    loginPanelMessageEl.textContent = pendingLogin.email
      ? `A sessão de ${pendingLogin.email} foi criada no perfil isolado. Conclua para salvá-la no vault.`
      : "A nova sessão foi criada no perfil isolado. Conclua para salvá-la no vault.";
    loginLinkEl.hidden = true;
    finishLoginBtn.hidden = false;
    return;
  }

  finishLoginBtn.hidden = true;
  if (status === "failed") {
    loginPanelTitleEl.textContent = "Falha no login isolado";
    loginPanelMessageEl.textContent = pendingLogin.error || "O Codex não conseguiu concluir a autenticação.";
    loginLinkEl.hidden = !pendingLogin.authUrl;
  } else {
    loginPanelTitleEl.textContent = "Login isolado em andamento";
    loginPanelMessageEl.textContent = "Conclua o login na aba do ChatGPT. A conta atualmente aberta no Codex Desktop não será desconectada.";
    loginLinkEl.hidden = !pendingLogin.authUrl;
  }

  if (pendingLogin.authUrl) loginLinkEl.href = pendingLogin.authUrl;
};

const startBrowserLogin = async (endpoint) => {
  const authTab = window.open("about:blank", "_blank");
  try {
    const result = await api(endpoint, { method: "POST", body: "{}" });
    const authUrl = result?.pending?.authUrl;
    if (!authUrl) throw new Error("O Codex não retornou a URL de autenticação.");

    if (authTab) {
      authTab.location.replace(authUrl);
    } else {
      toast("O navegador bloqueou a nova aba. Use o botão ‘Abrir login do ChatGPT’ no painel.", true);
    }
    await load();
  } catch (error) {
    try { authTab?.close(); } catch {}
    toast(error.message, true);
    await load();
  }
};

const renderAccounts = (accounts) => {
  summaryEl.textContent = `${accounts.length} conta${accounts.length === 1 ? "" : "s"} cadastrada${accounts.length === 1 ? "" : "s"}`;

  if (!accounts.length) {
    accountsEl.innerHTML = `
      <article class="card">
        <div class="accountName">Nenhuma conta salva</div>
        <div class="accountEmail">Clique em “Importar conta atual” para começar.</div>
      </article>
    `;
    return;
  }

  accountsEl.innerHTML = accounts
    .map((account) => {
      const limits = account.limits;
      return `
        <article class="card ${account.isActive ? "active" : ""}">
          <div class="cardTop">
            <div>
              <div class="accountName">${escapeHtml(account.name)}</div>
              <div class="accountEmail">${escapeHtml(account.email || "E-mail não identificado")}</div>
            </div>
          </div>

          <div class="badges">
            ${account.isActive ? '<span class="badge active">Ativa</span>' : ""}
            ${account.planType ? `<span class="badge">${escapeHtml(account.planType)}</span>` : ""}
            ${account.authState === "reauth_required" ? '<span class="badge warn">Reautenticacao necessaria</span>' : ""}
          </div>

          <div class="limits">
            ${
              limits?.primary || limits?.secondary
                ? `${limitHtml(limits.primary)}${limitHtml(limits.secondary)}<div class="limitFreshness">${escapeHtml(formatFetchedAt(limits.fetchedAt))}${account.isActive ? " · conta ativa; atualiza ao trocar" : " · atualização segura"}</div>`
                : '<div class="noLimits">Limites ainda não consultados.</div>'
            }
          </div>

          <div class="cardActions">
            ${account.authState === "reauth_required"
              ? `<button class="button primary" data-reauth="${account.id}">Reautenticar</button>`
              : `<button class="button ${account.isActive && currentAuthPresent ? "" : "primary"}" data-activate="${account.id}" ${account.isActive && currentAuthPresent ? "disabled" : ""}>
                  ${account.isActive ? (currentAuthPresent ? "Conta ativa" : "Restaurar") : "Ativar"}
                </button>`}
            <button class="dangerButton" data-delete="${account.id}" ${account.isActive ? "disabled" : ""}>Remover</button>
          </div>
        </article>
      `;
    })
    .join("");

  document.querySelectorAll("[data-activate]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.activate;
      button.disabled = true;
      try {
        const result = await api(`/api/accounts/${encodeURIComponent(id)}/activate`, {
          method: "POST",
          body: JSON.stringify({ restartCodex: restartToggle.checked })
        });
        toast(
          result.restartTriggered
            ? "Conta validada, ativada e Codex reiniciado."
            : "Conta validada e ativada. O Codex abrirá nessa conta."
        );
        await load();
      } catch (error) {
        toast(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-reauth]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await startBrowserLogin(`/api/accounts/${encodeURIComponent(button.dataset.reauth)}/reauth`);
      } finally {
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remover esta conta do vault local?")) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(button.dataset.delete)}`, {
          method: "DELETE"
        });
        toast("Conta removida.");
        await load();
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
};

const load = async () => {
  try {
    const [status, accountData] = await Promise.all([
      api("/api/status"),
      api("/api/accounts")
    ]);

    currentAuthPresent = Boolean(status.current);
    pendingLogin = status.pendingLogin ?? null;
    $("#runtimeDot").className = currentAuthPresent ? "dot ok" : "dot";
    $("#runtimeLabel").textContent = status.current?.email || "Codex sem sessão ativa";
    $("#runtimeDetail").textContent = status.codexHome;
    $("#importBtn").textContent = pendingLogin?.ready ? "Concluir login pendente" : "Importar conta atual";
    renderPendingLogin();
    renderAccounts(accountData.accounts);
  } catch (error) {
    $("#runtimeLabel").textContent = "Erro local";
    $("#runtimeDetail").textContent = error.message;
    toast(error.message, true);
  }
};

$("#importBtn").addEventListener("click", async () => {
  const name = pendingLogin?.ready ? null : prompt("Nome para esta conta (opcional):", "");
  if (!pendingLogin?.ready && name === null) return;
  try {
    const result = await api("/api/accounts/import-current", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    toast(result.importedPendingLogin
      ? `Sessao atualizada com seguranca: ${result.account.email || result.account.name}`
      : `Conta importada: ${result.account.email || result.account.name}`);
    await load();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#loginBtn").addEventListener("click", async () => {
  await startBrowserLogin("/api/login/open");
});

$("#refreshBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Atualizando…";
  try {
    const result = await api("/api/limits/refresh", {
      method: "POST",
      body: JSON.stringify({ mode: "safe" })
    });
    const failures = result.results.filter((x) => !x.ok);
    const skipped = result.results.filter((x) => x.ok && x.skipped);
    const updated = result.results.filter((x) => x.ok && !x.skipped);
    if (failures.length) {
      const firstError = failures[0]?.error ? ` Primeira falha: ${failures[0].error}` : "";
      toast(`${updated.length} conta(s) atualizada(s); ${skipped.length} preservada(s); ${failures.length} falharam.${firstError}`, true);
    } else if (skipped.length) {
      toast(`${updated.length} conta(s) atualizada(s). A conta ativa foi preservada porque o Codex está aberto.`);
    } else {
      toast(`${updated.length} conta(s) atualizada(s) agora.`);
    }
    await load();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Atualizar limites";
  }
});

const refreshLimitsInBackground = async () => {
  if (backgroundRefreshRunning || pendingLogin) return;
  backgroundRefreshRunning = true;
  try {
    await api("/api/limits/refresh", {
      method: "POST",
      body: JSON.stringify({ mode: "background" })
    });
    await load();
  } catch {
  } finally {
    backgroundRefreshRunning = false;
  }
};

finishLoginBtn.addEventListener("click", async () => {
  try {
    const result = await api("/api/accounts/import-current", {
      method: "POST",
      body: JSON.stringify({ name: null })
    });
    toast(`Sessão atualizada: ${result.account.email || result.account.name}`);
    await load();
  } catch (error) {
    toast(error.message, true);
  }
});

cancelLoginBtn.addEventListener("click", async () => {
  try {
    await api("/api/login/cancel", { method: "POST", body: "{}" });
    toast("Login isolado cancelado.");
    await load();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#dismissNotice").addEventListener("click", () => {
  $("#firstRunNotice").style.display = "none";
});

$("#shutdownBtn").addEventListener("click", async () => {
  try {
    await api("/api/shutdown", { method: "POST", body: "{}" });
    document.body.innerHTML =
      '<main class="shell"><h1>Gerenciador encerrado.</h1><p class="subtitle">Você pode fechar esta aba.</p></main>';
  } catch {}
});

load();
setInterval(load, 5000);
setTimeout(refreshLimitsInBackground, 3000);
setInterval(refreshLimitsInBackground, 60000);
