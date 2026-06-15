(() => {
  "use strict";

  const config = window.PANEL_CONFIG || {};
  const state = {
    owner: localStorage.getItem("panel.owner") || inferOwner(),
    repo: localStorage.getItem("panel.repo") || inferRepo(),
    token: sessionStorage.getItem("panel.token") || "",
    user: null,
    busy: false,
    status: null,
    pendingIconBase64: "",
    iconDirty: false,
    selectedPlayer: ""
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const pages = {
    server: "Servidor",
    identity: "Personalização",
    players: "Jogadores",
    options: "Opções",
    console: "Console",
    backups: "Backups",
    access: "Acesso"
  };

  function inferOwner() {
    const host = location.hostname;
    return host.endsWith(".github.io") ? host.split(".")[0] : "";
  }

  function inferRepo() {
    const firstPath = location.pathname.split("/").filter(Boolean)[0];
    return firstPath || config.defaultRepo || "minecraft-azure-panel";
  }

  function apiHeaders() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  function showNotice(message, type = "") {
    const notice = $("#notice");
    notice.textContent = message;
    notice.className = `notice ${type}`.trim();
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => notice.classList.add("hidden"), 7000);
  }

  function setBusy(busy, message = "") {
    state.busy = busy;
    $$(
      ".action-button, #identity-form button, #options-form button[type=submit], "
      + "#console-form button, .player-action-button, #gamemode-form button, "
      + "#skin-form button, #moderation-form button"
    ).forEach((button) => {
      button.disabled = busy || !state.token;
    });
    $("#refresh-button").disabled = busy;
    if (message) {
      showNotice(message);
    }
  }

  function switchPage(page) {
    $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.page === page));
    $$(".page").forEach((section) => section.classList.toggle("is-active", section.id === `page-${page}`));
    $("#page-title").textContent = pages[page] || "Painel";
    $(".sidebar").classList.remove("is-open");
    history.replaceState(null, "", `#${page}`);
  }

  function updateConnectionUi() {
    const connected = Boolean(state.token && state.user);
    const githubState = $("#github-state");
    githubState.innerHTML = connected
      ? `<span class="dot dot-on"></span><span>${escapeHtml(state.user.login)}</span>`
      : '<span class="dot dot-off"></span><span>GitHub desconectado</span>';
    $("#connect-button").textContent = connected ? "Trocar acesso" : "Conectar GitHub";
    $("#user-detail").textContent = connected ? state.user.login : "Nenhum";
    $("#repo-detail").textContent = state.owner && state.repo ? `${state.owner}/${state.repo}` : "Não configurado";
    $("#disconnect-button").classList.toggle("hidden", !connected);
    setBusy(false);
  }

  function serverAddress(port, address = config.serverAddress || "4.228.64.209") {
    return `${address}:${port}`;
  }

  function renderAddresses(address = config.serverAddress || "4.228.64.209") {
    const publicIp = address || config.serverAddress || "4.228.64.209";
    const host = state.status?.settings?.customHost || publicIp;
    const java = serverAddress(config.javaPort || 25565, host);
    const bedrock = serverAddress(config.bedrockPort || 19132, host);
    $("#java-address").textContent = java;
    $("#java-address-card").textContent = java;
    $("#bedrock-address-card").textContent = bedrock;
    const dnsIp = $("#dns-ip");
    if (dnsIp) dnsIp.textContent = publicIp;
  }

  function setServerIcon(dataUrl, name) {
    const fallback = String(name || "M").trim().charAt(0).toUpperCase() || "M";
    ["#server-icon-image", "#icon-preview-image"].forEach((selector) => {
      const image = $(selector);
      image.src = dataUrl || "";
      image.classList.toggle("hidden", !dataUrl);
    });
    ["#server-letter", "#icon-preview-letter"].forEach((selector) => {
      const letter = $(selector);
      letter.textContent = fallback;
      letter.classList.toggle("hidden", Boolean(dataUrl));
    });
  }

  function renderIdentity(settings) {
    const name = settings.serverName || "Mine-Etec";
    if (!state.iconDirty) {
      state.pendingIconBase64 = settings.iconBase64 || "";
    }

    $("#server-name").textContent = name;
    $(".brand strong").textContent = name;
    const form = $("#identity-form");
    form.elements.serverName.value = name;
    form.elements.customHost.value = settings.customHost || "";
    setServerIcon(state.pendingIconBase64, name);
  }

  function miniBadge(label, kind = "") {
    const badge = document.createElement("span");
    badge.className = `mini-badge ${kind}`.trim();
    badge.textContent = label;
    return badge;
  }

  function renderSelectedPlayer(player) {
    const title = $("#selected-player-title");
    const status = $("#selected-player-status");
    const hasPlayer = Boolean(player);

    title.textContent = hasPlayer ? player.name : "Nenhum jogador selecionado";
    $("#selected-player-name").value = hasPlayer ? player.name : "";
    status.className = "status-pill";
    status.classList.add(hasPlayer && player.online ? "status-running" : "status-unknown");
    status.textContent = hasPlayer && player.online ? "ONLINE" : "OFFLINE";

    $$(".player-action-button, #gamemode-form button, #skin-form button, #moderation-form button")
      .forEach((button) => {
        button.disabled = state.busy || !state.token || !hasPlayer;
      });
  }

  function selectPlayer(name) {
    state.selectedPlayer = name;
    const players = state.status?.server?.players || [];
    const player = players.find((item) => item.name === name);
    $$(".player-item").forEach((item) => {
      item.classList.toggle("is-selected", item.dataset.player === name);
    });
    renderSelectedPlayer(player);
  }

  function renderPlayers(players) {
    const list = $("#player-list");
    list.replaceChildren();

    if (!players.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Nenhum jogador conhecido ainda.";
      list.append(empty);
      renderSelectedPlayer(null);
      return;
    }

    players.forEach((player) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "player-item";
      button.dataset.player = player.name;

      const avatar = document.createElement("span");
      avatar.className = "player-avatar";
      avatar.textContent = player.name.charAt(0).toUpperCase();

      const info = document.createElement("span");
      info.className = "player-item-info";
      const name = document.createElement("strong");
      name.textContent = player.name;
      const badges = document.createElement("span");
      badges.className = "player-badges";
      badges.append(miniBadge(player.online ? "Online" : "Offline", player.online ? "online" : ""));
      if (player.op) badges.append(miniBadge("OP"));
      if (player.whitelisted) badges.append(miniBadge("Whitelist"));
      if (player.banned) badges.append(miniBadge("Banido"));
      info.append(name, badges);

      button.append(avatar, info);
      button.addEventListener("click", () => selectPlayer(player.name));
      list.append(button);
    });

    const selected = players.some((player) => player.name === state.selectedPlayer)
      ? state.selectedPlayer
      : players[0].name;
    selectPlayer(selected);
  }

  function renderStatus(status) {
    state.status = status;
    const vmState = status?.vm?.state || "unknown";
    const service = status?.server?.service || "unknown";
    const running = vmState.toLowerCase().includes("running") || vmState.toLowerCase().includes("executando");
    const pending = ["starting", "stopping", "deallocating"].some((item) => vmState.toLowerCase().includes(item));
    const pill = $("#status-pill");
    renderAddresses(status?.vm?.publicIp || config.serverAddress);

    pill.className = "status-pill";
    if (running && service === "active") {
      pill.classList.add("status-running");
      pill.textContent = "ONLINE";
    } else if (pending) {
      pill.classList.add("status-pending");
      pill.textContent = "PROCESSANDO";
    } else if (vmState !== "unknown") {
      pill.classList.add("status-stopped");
      pill.textContent = "OFFLINE";
    } else {
      pill.classList.add("status-unknown");
      pill.textContent = "DESCONHECIDO";
    }

    $("#service-status").textContent = service === "active"
      ? "Paper em execução"
      : service === "inactive"
        ? "Paper parado"
        : "Estado do Paper indisponível";
    $("#vm-state").textContent = formatVmState(vmState);
    $("#players-online").textContent = status?.server?.playersOnline ?? 0;
    $("#players-max").textContent = status?.server?.playersMax ?? status?.settings?.maxPlayers ?? 20;
    $("#view-distance").textContent = status?.settings?.viewDistance ?? 16;
    $("#simulation-distance").textContent = status?.settings?.simulationDistance ?? 6;
    $("#idle-state").textContent = status?.settings?.idleEnabled
      ? `${status.settings.idleMinutes || 30} min`
      : "Desativado";
    $("#last-action").textContent = formatOperation(status?.operation || "none");
    $("#last-message").textContent = status?.message || "Sem detalhes.";
    $("#activity-icon").textContent = status?.success === false ? "!" : "✓";
    $("#activity-icon").style.color = status?.success === false ? "#ef858b" : "";
    $("#last-update").textContent = status?.updatedAt
      ? `Atualizado ${new Date(status.updatedAt).toLocaleString("pt-BR")}`
      : "Sem atualização";

    renderIdentity(status?.settings || {});
    renderPlayers(status?.server?.players || []);
    fillOptions(status?.settings || {});
  }

  function fillOptions(settings) {
    const form = $("#options-form");
    for (const [key, value] of Object.entries(settings)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else {
        field.value = value;
      }
    }
  }

  function formatVmState(value) {
    const map = {
      running: "Em execução",
      deallocated: "Desalocada",
      stopped: "Parada",
      starting: "Iniciando",
      deallocating: "Desalocando",
      unknown: "Desconhecida"
    };
    const normalized = String(value).replace(/^PowerState\//i, "").toLowerCase();
    return map[normalized] || value;
  }

  function formatOperation(value) {
    const map = {
      none: "Nenhuma ação registrada",
      start: "VM iniciada",
      stop: "VM desalocada",
      restart: "Paper reiniciado",
      status: "Status atualizado",
      apply: "Configurações aplicadas",
      command: "Comando executado",
      backup: "Backup criado",
      update: "Servidor atualizado"
    };
    return map[value] || value;
  }

  async function connectGitHub(owner, repo, token) {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error("Token inválido ou sem acesso ao GitHub.");
    }
    const user = await response.json();
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!repoResponse.ok) {
      throw new Error(`Não foi possível acessar ${owner}/${repo}.`);
    }

    state.owner = owner;
    state.repo = repo;
    state.token = token;
    state.user = user;
    localStorage.setItem("panel.owner", owner);
    localStorage.setItem("panel.repo", repo);
    sessionStorage.setItem("panel.token", token);
    updateConnectionUi();
    await refreshStatus();
  }

  async function restoreSession() {
    if (!state.owner || !state.repo || !state.token) {
      updateConnectionUi();
      return;
    }
    try {
      await connectGitHub(state.owner, state.repo, state.token);
    } catch {
      disconnect();
    }
  }

  function disconnect() {
    state.token = "";
    state.user = null;
    sessionStorage.removeItem("panel.token");
    updateConnectionUi();
  }

  async function refreshStatus() {
    try {
      let status;
      if (state.token && state.owner && state.repo) {
        const response = await fetch(
          `https://api.github.com/repos/${state.owner}/${state.repo}/contents/docs/status.json?ref=main&t=${Date.now()}`,
          { headers: apiHeaders(), cache: "no-store" }
        );
        if (!response.ok) throw new Error("Não foi possível ler status.json.");
        const content = await response.json();
        status = JSON.parse(decodeBase64Utf8(content.content.replace(/\n/g, "")));
      } else {
        const response = await fetch(`status.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Status indisponível.");
        status = await response.json();
      }
      renderStatus(status);
    } catch (error) {
      showNotice(error.message, "error");
    }
  }

  async function dispatch(operation, payload = {}) {
    if (!state.token || !state.owner || !state.repo) {
      $("#auth-modal").showModal();
      return;
    }

    const requestId = crypto.randomUUID();
    const body = {
      ref: "main",
      inputs: {
        operation,
        payload: encodeBase64Utf8(JSON.stringify(payload)),
        request_id: requestId
      }
    };

    setBusy(true, `Solicitando: ${formatOperation(operation)}...`);
    try {
      const response = await fetch(
        `https://api.github.com/repos/${state.owner}/${state.repo}/actions/workflows/${config.workflowFile || "server-control.yml"}/dispatches`,
        {
          method: "POST",
          headers: {
            ...apiHeaders(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.message || `GitHub respondeu HTTP ${response.status}.`);
      }

      appendConsole(`Ação "${operation}" enviada ao GitHub Actions.`);
      await waitForRequest(requestId);
    } catch (error) {
      showNotice(error.message, "error");
      appendConsole(`Erro: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function waitForRequest(requestId) {
    const started = Date.now();
    while (Date.now() - started < 240000) {
      await sleep(5000);
      await refreshStatus();
      if (state.status?.requestId === requestId) {
        const type = state.status.success === false ? "error" : "success";
        showNotice(state.status.message || "Operação concluída.", type);
        appendConsole(state.status.message || "Operação concluída.");
        return;
      }
    }
    showNotice("A operação continua no GitHub Actions. Atualize o status em alguns instantes.");
  }

  function optionsPayload() {
    const form = $("#options-form");
    const identityForm = $("#identity-form");
    const data = new FormData(form);
    return {
      motd: String(data.get("motd") || ""),
      gamemode: String(data.get("gamemode")),
      difficulty: String(data.get("difficulty")),
      maxPlayers: Number(data.get("maxPlayers")),
      spawnProtection: Number(data.get("spawnProtection")),
      viewDistance: Number(data.get("viewDistance")),
      simulationDistance: Number(data.get("simulationDistance")),
      pvp: form.elements.pvp.checked,
      commandBlocks: form.elements.commandBlocks.checked,
      whitelist: form.elements.whitelist.checked,
      onlineMode: form.elements.onlineMode.checked,
      idleEnabled: form.elements.idleEnabled.checked,
      idleMinutes: Number(data.get("idleMinutes")),
      serverName: identityForm.elements.serverName.value.trim(),
      customHost: identityForm.elements.customHost.value.trim(),
      iconBase64: state.pendingIconBase64
    };
  }

  function validateOptions(payload) {
    if (payload.simulationDistance > payload.viewDistance) {
      throw new Error("A distância de simulação não pode exceder a distância visível.");
    }
    if (payload.viewDistance > 16) {
      return "Mais de 16 chunks pode sobrecarregar esta VM de 2 vCPUs. Aplicar mesmo assim?";
    }
    if (payload.onlineMode) {
      return "Ativar verificação oficial impedirá launchers não oficiais. Aplicar?";
    }
    return "";
  }

  async function confirmAction(title, message) {
    const modal = $("#confirm-modal");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    modal.showModal();
    const result = await new Promise((resolve) => {
      modal.addEventListener("close", () => resolve(modal.returnValue === "confirm"), { once: true });
    });
    return result;
  }

  function appendConsole(message) {
    const output = $("#console-output");
    const line = document.createElement("p");
    const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    line.innerHTML = `<span class="console-time">${now}</span> ${escapeHtml(message)}`;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function decodeBase64Utf8(value) {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function imageToServerIcon(file) {
    if (!file.type.startsWith("image/")) {
      throw new Error("Escolha uma imagem PNG, JPG ou WebP.");
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("A imagem deve ter no máximo 5 MB.");
    }

    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    const size = Math.min(bitmap.width, bitmap.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - size) / 2,
      (bitmap.height - size) / 2,
      size,
      size,
      0,
      0,
      64,
      64
    );
    bitmap.close();
    return canvas.toDataURL("image/png");
  }

  async function runPlayerAction(playerAction, extra = {}) {
    if (!state.selectedPlayer) {
      throw new Error("Selecione um jogador.");
    }
    await dispatch("command", {
      playerAction,
      player: state.selectedPlayer,
      ...extra
    });
  }

  function bindEvents() {
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
    $("#menu-button").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));
    $("#refresh-button").addEventListener("click", async () => {
      if (state.token) {
        await dispatch("status");
      } else {
        await refreshStatus();
      }
    });

    ["#connect-button", "#access-connect-button"].forEach((selector) => {
      $(selector).addEventListener("click", () => {
        const form = $("#auth-form");
        form.elements.owner.value = state.owner;
        form.elements.repo.value = state.repo;
        form.elements.token.value = "";
        $("#auth-modal").showModal();
      });
    });

    $("#disconnect-button").addEventListener("click", disconnect);
    $("#auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submitter = event.submitter?.value;
      if (submitter === "cancel") {
        $("#auth-modal").close();
        return;
      }
      try {
        await connectGitHub(
          form.elements.owner.value.trim(),
          form.elements.repo.value.trim(),
          form.elements.token.value.trim()
        );
        $("#auth-modal").close();
        showNotice("GitHub conectado.", "success");
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $$(".action-button").forEach((button) => button.addEventListener("click", async () => {
      const operation = button.dataset.action;
      if (operation === "stop") {
        const confirmed = await confirmAction(
          "Parar e desalocar",
          "O servidor será salvo, desligado e a cobrança de computação será interrompida."
        );
        if (!confirmed) return;
      }
      if (operation === "update") {
        const confirmed = await confirmAction(
          "Atualizar servidor",
          "Será criado um backup e o Paper será reiniciado. Jogadores conectados serão desconectados."
        );
        if (!confirmed) return;
      }
      await dispatch(operation);
    }));

    $("#options-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const payload = optionsPayload();
        const warning = validateOptions(payload);
        if (warning && !(await confirmAction("Confirmar configuração", warning))) return;
        await dispatch("apply", payload);
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#identity-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const payload = optionsPayload();
        const warning = validateOptions(payload);
        if (warning && !(await confirmAction("Confirmar configuração", warning))) return;
        await dispatch("apply", payload);
        state.iconDirty = false;
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#icon-file").addEventListener("change", async (event) => {
      const [file] = event.target.files;
      if (!file) return;
      try {
        state.pendingIconBase64 = await imageToServerIcon(file);
        state.iconDirty = true;
        setServerIcon(
          state.pendingIconBase64,
          $("#identity-form").elements.serverName.value
        );
        showNotice("Imagem pronta. Clique em Salvar personalização.", "success");
      } catch (error) {
        showNotice(error.message, "error");
      } finally {
        event.target.value = "";
      }
    });

    $("#remove-icon-button").addEventListener("click", () => {
      state.pendingIconBase64 = "";
      state.iconDirty = true;
      setServerIcon("", $("#identity-form").elements.serverName.value);
    });

    $("#identity-form").elements.serverName.addEventListener("input", (event) => {
      setServerIcon(state.pendingIconBase64, event.target.value);
    });

    $$(".player-action-button").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await runPlayerAction(button.dataset.playerAction);
        } catch (error) {
          showNotice(error.message, "error");
        }
      });
    });

    $("#gamemode-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await runPlayerAction("gamemode", { gamemode: $("#player-gamemode").value });
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#skin-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const skin = $("#skin-name").value.trim();
        if (!skin) throw new Error("Informe o nome da skin.");
        await runPlayerAction("skin-set", { skin });
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#clear-skin-button").addEventListener("click", async () => {
      try {
        await runPlayerAction("skin-clear");
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#moderation-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const action = event.submitter?.dataset.moderationAction;
        if (!action) return;
        await runPlayerAction(action, { reason: $("#moderation-reason").value.trim() });
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    $("#refresh-players-button").addEventListener("click", async () => {
      if (state.token) {
        await dispatch("status");
      } else {
        await refreshStatus();
      }
    });

    $("#console-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $("#console-command");
      const command = input.value.trim().replace(/^\//, "");
      if (!command) return;
      appendConsole(`> ${command}`);
      input.value = "";
      await dispatch("command", { command });
    });

    $("#copy-java-address").addEventListener("click", () => copyText($("#java-address").textContent));
    $$("[data-copy-target]").forEach((button) => button.addEventListener("click", () => {
      copyText($(`#${button.dataset.copyTarget}`).textContent);
    }));
  }

  async function copyText(value) {
    await navigator.clipboard.writeText(value);
    showNotice("Endereço copiado.", "success");
  }

  async function init() {
    renderAddresses();
    bindEvents();
    switchPage(location.hash.slice(1) in pages ? location.hash.slice(1) : "server");
    await refreshStatus();
    await restoreSession();
  }

  init();
})();
