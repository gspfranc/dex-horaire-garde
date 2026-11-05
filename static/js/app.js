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

  let STATS = readJSON("bootstrap-stats", null);
  let scope = "month";

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
    if (!block || !block.tagged) return "Aucune journée attribuée pour cette période.";
    if (!block.leader) return "<b>Parfaitement à égalité</b> — " + block.counts.Oli + " jours chacun.";
    const plural = block.gap > 1 ? "jours" : "jour";
    return "<b>" + block.leader + "</b> a " + block.gap + " " + plural + " de plus.";
  }

  function renderStats() {
    if (!statsPanel || !STATS) return;
    const block = STATS[scope];
    if (!block) return;

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

  if (statsPanel) {
    statsPanel.querySelectorAll(".scopetab").forEach((tab) => {
      tab.addEventListener("click", () => {
        scope = tab.dataset.scope;
        statsPanel.querySelectorAll(".scopetab").forEach((t) => {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", String(active));
        });
        renderStats();
      });
    });
    renderStats();
  }

  /* ------------------------- application des entrées ---------------------- */

  function applyEntry(iso, entry) {
    const cell = cellFor(iso);
    if (!cell) return;
    const owner = (entry && entry.owner) || "";
    const note = (entry && entry.note) || "";

    cell.dataset.owner = owner;
    const ownerEl = cell.querySelector(".day__owner");
    const noteEl = cell.querySelector(".day__note");
    if (ownerEl) ownerEl.textContent = owner;
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
    const response = await fetch("/api/entries", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
      }
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
    if (ownerEl) ownerEl.textContent = brush === ERASE ? "" : brush;
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
})();
