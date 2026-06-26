(() => {
  const idHints = {
    createBtn: "Create",
    accountsBtn: "Accounts",
    syncBtn: "Sync",
    undoBtn: "Undo",
    redoBtn: "Redo",
    logoutBtn: "Logout",
    sidebarToggleBtn: "Menu",
    sidebarCloseBtn: "Close",
    addStickyNoteBtn: "Add Sticky",
    stickyBackToEventBtn: "Back",
    deleteStickyBtn: "Delete Sticky",
    deleteEventBtn: "Delete Event",
    openStickyFromEventBtn: "Open Sticky",
    cancelEventBtn: "Cancel",
    saveEventBtn: "Save",
    "apple-test-btn": "Test",
    "apple-connect-btn": "Connect"
  };

  function toHintFromText(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return "Action";
    const words = normalized.split(" ").slice(0, 2);
    return words.join(" ");
  }

  function applyButtonHints() {
    const nodes = document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']");

    nodes.forEach((node) => {
      const idHint = idHints[node.id] || "";
      const textHint = toHintFromText(node.textContent || node.value || node.getAttribute("aria-label") || "");
      const hint = idHint || textHint;

      if (!node.getAttribute("title") && hint) {
        node.setAttribute("title", hint);
      }
      if (!node.getAttribute("aria-label") && hint) {
        node.setAttribute("aria-label", hint);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyButtonHints);
  } else {
    applyButtonHints();
  }

  // Re-apply as dynamic UI elements are added.
  const observer = new MutationObserver(() => applyButtonHints());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
