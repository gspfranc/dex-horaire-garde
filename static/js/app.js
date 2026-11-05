/* ==========================================================================
   DEX — logique du calendrier de garde
   - sélection d'un « pinceau » (Oli / Phil / Effacer) + peinture au glisser
   - fiche détaillée par journée (gardien + note libre + plage de dates)
   - statistiques recalculées à chaque modification
   ========================================================================== */

(function () {
  "use strict";

  const readJSON = (id, fallback) => {
    const node = document.getElementById(id);
    if (!node) return fallback;
    try { return JSON.parse(node.textContent); } catch (_) { return fallback; }
  };

  const CONFIG = readJSON("bootstrap-config", {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    canEdit: false,
    monthNames: [],
    people: ["Oli", "Phil"],
  });

  // Bilan de l'annee affichee. Les totaux sont annuels, jamais mensuels.
  let STATS = readJSON("bootstrap-stats", null);

  const calendar = document.getElementById("calendar");
  const statsPanel = document.getElementById("stats");

  /* --------------------------------- outils -------------------------------- */

  const cellFor = (iso) =>
    calendar ? calendar.querySelector('.day[data-date="' + iso + '"]') : null;

  const pad = (n) => String(n).padStart(2, "0");
  const toISO = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const fromISO = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };

  function rangeISO(startISO, endISO) {
    let a = fromISO(startISO), b = fromISO(endISO);
    if (a > b) { const t = a; a = b; b = t; }
    const out = [];
    const cursor = new Date(a);
    while (cursor <= b && out.length < 400) {
      out.push(toISO(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  function prettyDate(iso) {
    const d = fromISO(iso);
    const names = CONFIG.monthNames || [];
    const dow = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][d.getDay()];
    const month = (names[d.getMonth()] || "").toLowerCase();
    return dow + " " + d.getDate() + " " + month + " " + d.getFullYear();
  }

  let toastTimer = null;
  function toast(message, isError) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " toast--error" : "");
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), isError ? 4200 : 2200);
  }

  /* ----------------------------- statistiques ----------------------------- */

  function pick(obj, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }

  function caption(block) {
    if (!block || !block.tagged) return "Aucune journée attribuée en " + CONFIG.year + ".";
    if (!block.leader) return "<b>Parfaitement à égalité</b> — " + block.counts.Oli + " jours chacun.";
    const plural = block.gap > 1 ? "jours" : "jour";
    return "<b>" + block.leader + "</b> a " + block.gap + " " + plural + " de plus.";
  }

  function renderStats() {
    if (!statsPanel || !STATS) return;
    const block = STATS;

    statsPanel.querySelectorAll("[data-metric]").forEach((node) => {
      const path = node.dataset.metric;

      if (path === "caption") { node.innerHTML = caption(block); return; }

      let value = pick(block, path);
      if (value === undefined || value === null) value = path === "untagged" ? "—" : 0;

      if (node.dataset.style === "width") {
        node.style.width = (typeof value === "number" ? value : 0) + "%";
        return;
      }
      node.textContent = value + (node.dataset.suffix || "");
    });
  }

  if (statsPanel) renderStats();

  /* ------------------------- application des entrées ---------------------- */

  function applyEntry(iso, entry) {
    const cell = cellFor(iso);
    if (!cell) return;
    const owner = (entry && entry.owner) || "";
    const note = (entry && entry.note) || "";

    cell.dataset.owner = owner;
    const ownerEl = cell.querySelector(".day__owner");
    const noteEl = cell.querySelector(".day__note");
    if (ownerEl) {
      ownerEl.textContent = owner;
      // L'initiale sert d'etiquette sur petit ecran, ou le nom ne tient pas.
      ownerEl.dataset.initial = owner ? owner.charAt(0) : "";
    }
    if (noteEl) noteEl.textContent = note;

    let label = prettyDate(iso);
    if (owner) label += " — " + owner;
    if (note) label += " — " + note;
    cell.setAttribute("aria-label", label);

    cell.classList.add("is-saving");
    setTimeout(() => cell.classList.remove("is-saving"), 500);
  }

  /* -------------------------------- requêtes ------------------------------ */

  async function send(method, body) {
    // « year » indique l'année affichée, pour que le bilan renvoyé soit le bon
    // même quand la plage modifiée chevauche deux années.
    const outgoing = Object.assign({ year: CONFIG.year }, body);
    const response = await fetch("/api/entries", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outgoing),
    });

    if (response.status === 401) {
      toast("Session expirée — reconnectez-vous.", true);
      setTimeout(() => {
        window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname);
      }, 1400);
      throw new Error("unauthorized");
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Erreur " + response.status);

    (body.dates || []).forEach((iso) => applyEntry(iso, payload.entries && payload.entries[iso]));
    if (payload.stats) { STATS = payload.stats; renderStats(); }
    return payload;
  }

  async function saveDates(dates, patch) {
    if (!dates.length) return;
    try {
      await send("POST", Object.assign({ dates }, patch));
      const count = dates.length;
      toast(count === 1 ? "Journée enregistrée." : count + " journées enregistrées.");
    } catch (error) {
      if (error.message !== "unauthorized") toast(error.message, true);
    }
  }

  async function clearDates(dates) {
    if (!dates.length) return;
    try {
      await send("DELETE", { dates });
      toast(dates.length === 1 ? "Journée effacée." : dates.length + " journées effacées.");
    } catch (error) {
      if (error.message !== "unauthorized") toast(error.message, true);
    }
  }

  /* ----------------------- mise en évidence depuis #ancre ----------------- */

  if (window.location.hash.length > 1) {
    const target = cellFor(window.location.hash.slice(1));
    if (target) {
      target.classList.add("is-saving");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => target.classList.remove("is-saving"), 1200);
    }
  }

  /* ---------------------------- navigation clavier ------------------------ */

  if (calendar) {
    calendar.addEventListener("keydown", (event) => {
      const cell = event.target.closest(".day");
      if (!cell) return;
      const cells = Array.from(calendar.querySelectorAll(".day"));
      const index = cells.indexOf(cell);
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

      if (event.key in steps) {
        const next = cells[index + steps[event.key]];
        if (next) { next.focus(); event.preventDefault(); }
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (typeof window.dexActivateCell === "function") window.dexActivateCell(cell);
        else cell.click();
      }
    });
  }

  /* --------------------------- detail en lecture --------------------------- */

  // Sur petit ecran, la note se reduit a une pastille : une pression sur la
  // journee en revele le contenu. En mode edition la fiche complete s'ouvre
  // deja, ce repli ne sert donc qu'en lecture seule.
  if (calendar && !CONFIG.canEdit) {
    calendar.addEventListener("click", (event) => {
      const cell = event.target.closest(".day");
      if (!cell) return;
      const owner = cell.dataset.owner || "";
      const noteEl = cell.querySelector(".day__note");
      const note = noteEl ? noteEl.textContent.trim() : "";
      if (!owner && !note) return;

      const parts = [prettyDate(cell.dataset.date)];
      if (owner) parts.push(owner);
      if (note) parts.push(note);
      toast(parts.join("  ·  "));
    });
  }

  /* ========================== édition (si autorisée) ====================== */

  if (!CONFIG.canEdit || !calendar) return;

  const ERASE = "__erase";
  let brush = "";

  const brushbar = document.getElementById("brushbar");
  const brushHint = document.getElementById("brush-hint");

  const HINTS = {
    "": "Cliquez un jour pour ouvrir sa fiche.",
    [ERASE]: "Cliquez ou glissez pour effacer des journées.",
  };

  if (brushbar) {
    brushbar.querySelectorAll(".brush").forEach((button) => {
      button.addEventListener("click", () => {
        brush = button.dataset.brush;
        brushbar.querySelectorAll(".brush").forEach((b) => {
          const active = b === button;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        // Libère le défilement tactile tant qu'aucun pinceau n'est choisi.
        document.body.classList.toggle("brush-on", Boolean(brush));
        if (brushHint) {
          brushHint.textContent =
            HINTS[brush] || "Cliquez ou glissez pour attribuer les jours à " + brush + ".";
        }
      });
    });
  }

  /* --------------------------- peinture au glisser ------------------------ */

  let painting = false;
  let painted = null;

  function paintCell(cell) {
    if (!cell || painted.has(cell.dataset.date)) return;
    painted.add(cell.dataset.date);
    cell.classList.add("is-painting");
    cell.dataset.owner = brush === ERASE ? "" : brush;
    const ownerEl = cell.querySelector(".day__owner");
    if (ownerEl) {
      const name = brush === ERASE ? "" : brush;
      ownerEl.textContent = name;
      ownerEl.dataset.initial = name ? name.charAt(0) : "";
    }
    if (brush === ERASE) {
      const noteEl = cell.querySelector(".day__note");
      if (noteEl) noteEl.textContent = "";
    }
  }

  function endPainting() {
    if (!painting) return;
    painting = false;
    calendar.querySelectorAll(".is-painting").forEach((c) => c.classList.remove("is-painting"));
    const dates = Array.from(painted);
    painted = null;
    if (!dates.length) return;
    if (brush === ERASE) clearDates(dates);
    else saveDates(dates, { owner: brush });
  }

  calendar.addEventListener("pointerdown", (event) => {
    const cell = event.target.closest(".day");
    if (!cell) return;

    if (!brush) return; // mode « Détails » : géré au clic

    event.preventDefault();
    painting = true;
    painted = new Set();
    paintCell(cell);
  });

  // pointermove + elementFromPoint : fonctionne aussi au doigt, alors que
  // pointerover ne suit pas le déplacement tactile.
  document.addEventListener("pointermove", (event) => {
    if (!painting) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under) paintCell(under.closest(".day"));
  });

  document.addEventListener("pointerup", endPainting);
  document.addEventListener("pointercancel", endPainting);

  /* -------------------------------- la fiche ------------------------------ */

  const modal = document.getElementById("editor");
  const form = document.getElementById("editor-form");
  const titleEl = document.getElementById("editor-title");
  const subEl = document.getElementById("editor-sub");
  const noteInput = document.getElementById("editor-note");
  const rangeToggle = document.getElementById("editor-range-on");
  const rangeEnd = document.getElementById("editor-range-end");
  const clearBtn = document.getElementById("editor-clear");

  if (!modal || !form) return;

  let activeDate = null;
  let pickedOwner = "";

  function setPickedOwner(owner) {
    pickedOwner = owner || "";
    form.querySelectorAll(".ownerpick__btn").forEach((b) =>
      b.classList.toggle("is-active", (b.dataset.owner || "") === pickedOwner)
    );
  }

  function openEditor(iso) {
    const cell = cellFor(iso);
    if (!cell) return;
    activeDate = iso;

    const noteEl = cell.querySelector(".day__note");
    titleEl.textContent = prettyDate(iso).replace(/^./, (c) => c.toUpperCase());
    subEl.textContent = "Gardien et note libre pour cette journée.";
    noteInput.value = noteEl ? noteEl.textContent.trim() : "";
    setPickedOwner(cell.dataset.owner);

    rangeToggle.checked = false;
    rangeEnd.value = iso;
    rangeEnd.min = iso;

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => noteInput.focus(), 60);
  }

  function closeEditor() {
    modal.hidden = true;
    activeDate = null;
    document.body.style.overflow = "";
  }

  function targetDates() {
    if (!activeDate) return [];
    if (rangeToggle.checked && rangeEnd.value) return rangeISO(activeDate, rangeEnd.value);
    return [activeDate];
  }

  /** Clic ou touche Entrée sur une journée : peindre ou ouvrir la fiche. */
  function activateCell(cell) {
    if (!cell) return;
    const iso = cell.dataset.date;
    if (!brush) { openEditor(iso); return; }
    if (brush === ERASE) clearDates([iso]);
    else saveDates([iso], { owner: brush });
  }
  window.dexActivateCell = activateCell;

  calendar.addEventListener("click", (event) => {
    if (brush) return; // déjà traité par la peinture au pointeur
    activateCell(event.target.closest(".day"));
  });

  form.querySelectorAll(".ownerpick__btn").forEach((button) => {
    button.addEventListener("click", () => setPickedOwner(button.dataset.owner));
  });

  /* Les champs de date ouvrent leur calendrier au clic sur n'importe quelle
     partie du champ, pas seulement sur la petite icône. */
  function openPicker(input) {
    if (typeof input.showPicker !== "function") return;
    try { input.showPicker(); } catch (_) { /* déjà ouvert, ou non autorisé */ }
  }

  document.querySelectorAll('input[type="date"]').forEach((input) => {
    input.addEventListener("click", () => openPicker(input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker(input);
      }
    });
  });

  // Choisir une date de fin active la plage sans avoir à cocher la case.
  rangeEnd.addEventListener("change", () => {
    rangeToggle.checked = Boolean(rangeEnd.value);
  });

  rangeToggle.addEventListener("change", () => {
    if (rangeToggle.checked) { rangeEnd.focus(); openPicker(rangeEnd); }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const dates = targetDates();
    closeEditor();
    saveDates(dates, { owner: pickedOwner, note: noteInput.value });
  });

  clearBtn.addEventListener("click", () => {
    const dates = targetDates();
    closeEditor();
    clearDates(dates);
  });

  modal.querySelectorAll("[data-close]").forEach((node) =>
    node.addEventListener("click", closeEditor)
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeEditor();
  });


  /* ========================= outils de base de donnees ==================== */

  /** Ouvre/ferme une modale en bloquant le defilement de la page. */
  function showModal(node, onOpen) {
    closeEditor();
    node.hidden = false;
    document.body.style.overflow = "hidden";
    if (onOpen) onOpen();
  }
  function hideModal(node) {
    node.hidden = true;
    document.body.style.overflow = "";
  }

  /** Affiche une erreur DANS la modale : un message fugace peut passer
      inapercu et donner l'impression que le bouton ne fait rien. */
  function showError(node, message) {
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }
  function hideError(node) {
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
  }

  /** Branche les fermetures (croix, bouton Annuler, fond, touche Echap). */
  function wireClose(node, reset) {
    const close = () => { hideModal(node); if (reset) reset(); };
    node.querySelectorAll("[data-close]").forEach((el) =>
      el.addEventListener("click", close)
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !node.hidden) close();
    });
    return close;
  }

  /* ----------------------- reinitialisation complete ---------------------- */

  const resetModal = document.getElementById("reset-modal");
  const resetOpen = document.getElementById("reset-open");

  if (resetModal && resetOpen) {
    const resetForm = document.getElementById("reset-form");
    const resetInput = document.getElementById("reset-confirm");
    const resetSubmit = document.getElementById("reset-submit");
    const resetHint = document.getElementById("reset-hint");
    const resetError = document.getElementById("reset-error");
    const PHRASE = (CONFIG.resetPhrase || "REINITIALISER").toUpperCase();
    const HINT_IDLE = resetHint ? resetHint.textContent.trim() : "";

    const clearReset = () => {
      resetInput.value = "";
      resetSubmit.disabled = true;
      resetSubmit.textContent = "Tout supprimer";
      hideError(resetError);
      if (resetHint) {
        resetHint.textContent = HINT_IDLE;
        resetHint.classList.remove("is-ready");
      }
    };
    wireClose(resetModal, clearReset);

    resetOpen.addEventListener("click", () => {
      showModal(resetModal, () => {
        clearReset();
        setTimeout(() => resetInput.focus(), 60);
      });
    });

    // Le bouton ne s'active qu'avec la phrase exacte : un clic seul ne peut
    // pas effacer l'historique. L'indication dit pourquoi il reste inactif.
    resetInput.addEventListener("input", () => {
      const ready = resetInput.value.trim().toUpperCase() === PHRASE;
      resetSubmit.disabled = !ready;
      if (resetHint) {
        resetHint.textContent = ready
          ? "Confirmation reconnue — le bouton est actif."
          : HINT_IDLE;
        resetHint.classList.toggle("is-ready", ready);
      }
    });

    resetForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (resetSubmit.disabled) return;
      hideError(resetError);
      resetSubmit.disabled = true;
      resetSubmit.textContent = "Suppression…";

      try {
        const data = await postJSON("/api/reset", {
          confirm: resetInput.value.trim().toUpperCase(),
          year: CONFIG.year,
        });
        finishAndReload("reset", data.removed || 0);
      } catch (error) {
        if (error.message === "unauthorized") return;
        // La modale reste ouverte avec le motif affiche, pour que l'echec
        // soit visible au lieu de passer pour un bouton inerte.
        showError(resetError, error.message);
        resetSubmit.textContent = "Réessayer";
        resetSubmit.disabled = false;
      }
    });
  }

  /* ------------------------------- import -------------------------------- */

  const importModal = document.getElementById("import-modal");
  const importOpen = document.getElementById("import-open");

  if (importModal && importOpen) {
    const importForm = document.getElementById("import-form");
    const importFile = document.getElementById("import-file");
    const importName = document.getElementById("import-name");
    const importSubmit = document.getElementById("import-submit");
    const dropzone = document.getElementById("import-drop");
    const importError = document.getElementById("import-error");
    const PLACEHOLDER = importName.textContent;

    const clearImport = () => {
      importFile.value = "";
      importName.textContent = PLACEHOLDER;
      importSubmit.disabled = true;
      importSubmit.textContent = "Remplacer les données";
      dropzone.classList.remove("is-filled", "is-over");
      hideError(importError);
    };
    const closeImport = wireClose(importModal, clearImport);

    importOpen.addEventListener("click", () => showModal(importModal, clearImport));

    const MAX_BYTES = CONFIG.maxImportBytes || 16 * 1024 * 1024;

    function pickFile(file) {
      if (!file) return;

      // Refus immediat d'un fichier trop gros : evite un envoi inutile, que le
      // serveur rejetterait en coupant la connexion.
      if (file.size > MAX_BYTES) {
        clearImport();
        importName.textContent =
          "Fichier trop volumineux (max " + Math.round(MAX_BYTES / 1048576) + " Mo)";
        toast("Fichier trop volumineux.", true);
        return;
      }

      importName.textContent = file.name + " — " + Math.round(file.size / 1024) + " Ko";
      importSubmit.disabled = false;
      dropzone.classList.add("is-filled");
    }

    importFile.addEventListener("change", () => pickFile(importFile.files[0]));

    // Depot par glisser : DataTransfer permet d'alimenter le champ fichier.
    ["dragenter", "dragover"].forEach((type) =>
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-over");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      dropzone.addEventListener(type, () => dropzone.classList.remove("is-over"))
    );
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      const file = event.dataTransfer && event.dataTransfer.files[0];
      if (!file) return;
      try {
        const bag = new DataTransfer();
        bag.items.add(file);
        importFile.files = bag.files;
      } catch (_) { /* navigateur sans DataTransfer inscriptible */ }
      pickFile(file);
    });

    importForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = importFile.files[0];
      if (!file) return;

      importSubmit.disabled = true;
      importSubmit.textContent = "Import…";

      const body = new FormData();
      body.append("file", file);
      body.append("year", String(CONFIG.year));

      try {
        const response = await fetch("/api/import", { method: "POST", body });
        if (response.status === 401) return bounceToLogin();
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Erreur " + response.status);
        finishAndReload("import", data.imported || 0);
      } catch (error) {
        // Motif affiche dans la modale : l'utilisateur voit pourquoi le
        // fichier a ete refuse et peut en choisir un autre.
        showError(importError, error.message);
        importSubmit.textContent = "Réessayer";
        importSubmit.disabled = false;
      }
    });
  }

  /* ------------------------------- communs -------------------------------- */

  function bounceToLogin() {
    toast("Session expirée — reconnectez-vous.", true);
    setTimeout(() => {
      window.location.href =
        "/login?next=" + encodeURIComponent(window.location.pathname);
    }, 1400);
  }

  async function postJSON(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      bounceToLogin();
      throw new Error("unauthorized");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Erreur " + response.status);
    return data;
  }

  /** Recharge la page : toutes les cases doivent repartir du nouvel etat. */
  function finishAndReload(kind, count) {
    // sessionStorage peut etre bloque par une politique de confidentialite :
    // le rechargement doit avoir lieu quand meme.
    try {
      sessionStorage.setItem("dex-done", kind + ":" + count);
    } catch (_) { /* message de confirmation simplement omis */ }
    window.location.reload();
  }

  // Message affiche apres le rechargement.
  let done = null;
  try { done = sessionStorage.getItem("dex-done"); } catch (_) { done = null; }
  if (done !== null) {
    try { sessionStorage.removeItem("dex-done"); } catch (_) {}
    const [kind, raw] = done.split(":");
    const n = Number(raw) || 0;
    const jours = n + (n > 1 ? " journées" : " journée");
    toast(
      kind === "import"
        ? "Base importée — " + jours + " chargée" + (n > 1 ? "s." : ".")
        : n > 0
          ? "Base réinitialisée — " + jours + " supprimée" + (n > 1 ? "s." : ".")
          : "Base réinitialisée."
    );
  }
})();
