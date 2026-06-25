/**
 * UndoRedoManager - Centralized undo/redo system for all UI operations
 * 
 * Usage:
 *   1. Create a command object: { execute: async fn, undo: async fn, label: "Action description" }
 *   2. Call: window.undoRedoManager.execute(command)
 *   3. Keyboard: Ctrl+Z to undo, Ctrl+Y or Ctrl+Shift+Z to redo
 *   4. UI: Click undo/redo buttons or call window.undoRedoManager.undo() / .redo()
 */

export class UndoRedoManager {
  constructor(maxHistory = 50) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = maxHistory;
    this.isExecuting = false;
    this.listeners = [];
  }

  /**
   * Register a command that has already been executed
   * Use this when the command execution returns a value needed before adding to history
   */
  async registerExecuted(command) {
    if (this.isExecuting) return;
    if (!command) return;

    this.isExecuting = true;
    try {
      this.undoStack.push(command);

      // Limit history size
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
      }

      // Clear redo stack on new action
      this.redoStack = [];
      this.notifyListeners();
    } catch (err) {
      console.error("❌ Command registration failed:", err);
      throw err;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Execute a command and add to history
    if (this.isExecuting) return;
    if (!command || typeof command.execute !== "function") return;

    this.isExecuting = true;
    try {
      await command.execute();
      this.undoStack.push(command);

      // Limit history size
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
      }

      // Clear redo stack on new action
      this.redoStack = [];
      this.notifyListeners();
    } catch (err) {
      console.error("❌ Command execution failed:", err);
      throw err;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Undo the last action
   */
  async undo() {
    if (this.isExecuting || this.undoStack.length === 0) return false;

    this.isExecuting = true;
    try {
      const command = this.undoStack.pop();
      if (command.undo) {
        await command.undo();
      }
      this.redoStack.push(command);
      this.notifyListeners();
      window.showToast?.("↶ Undone: " + (command.label || "Action"));
      return true;
    } catch (err) {
      console.error("❌ Undo failed:", err);
      window.showToast?.("❌ Undo failed", "error");
      return false;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Redo the last undone action
   */
  async redo() {
    if (this.isExecuting || this.redoStack.length === 0) return false;

    this.isExecuting = true;
    try {
      const command = this.redoStack.pop();
      if (command.execute) {
        await command.execute();
      }
      this.undoStack.push(command);
      this.notifyListeners();
      window.showToast?.("↷ Redone: " + (command.label || "Action"));
      return true;
    } catch (err) {
      console.error("❌ Redo failed:", err);
      window.showToast?.("❌ Redo failed", "error");
      return false;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Get current undo/redo state for UI updates
   */
  getState() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label || "Undo",
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label || "Redo",
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length
    };
  }

  /**
   * Clear all history
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyListeners();
  }

  /**
   * Register listener for state changes
   */
  onChange(listener) {
    if (typeof listener === "function") {
      this.listeners.push(listener);
    }
  }

  /**
   * Notify all listeners of state change
   */
  notifyListeners() {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  /**
   * Serialize history to JSON (for debugging)
   */
  toJSON() {
    return {
      undo: this.undoStack.map((cmd) => cmd.label || "Action"),
      redo: this.redoStack.map((cmd) => cmd.label || "Action")
    };
  }
}

// Initialize global manager
window.undoRedoManager = new UndoRedoManager(100);

/**
 * Setup keyboard shortcuts for undo/redo
 */
export function setupUndoRedoKeyboard() {
  document.addEventListener("keydown", async (e) => {
    if (window.isModalOpen) {
      // Allow Ctrl+Z in modal but not other operations
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        await window.undoRedoManager.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        await window.undoRedoManager.redo();
      }
      return;
    }

    // Undo: Ctrl+Z or Cmd+Z
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      await window.undoRedoManager.undo();
      return;
    }

    // Redo: Ctrl+Y, Ctrl+Shift+Z, or Cmd+Y
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      await window.undoRedoManager.redo();
      return;
    }
  });
}

/**
 * Create command for event save (create/edit)
 */
export function createEventSaveCommand(isEdit, eventId, payload, previousEvent) {
  return {
    label: isEdit ? "Edit event" : "Create event",
    execute: async () => {
      const res = await apiFetch(isEdit ? `/calendar/event/${eventId}` : "/calendar/event", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res || !res.ok) throw new Error("Save failed");
      return res.json();
    },
    undo: async () => {
      if (!isEdit) {
        // Undo create = delete
        const res = await apiFetch(`/calendar/event/${eventId}`, { method: "DELETE" });
        if (!res || !res.ok) throw new Error("Delete failed");
      } else if (previousEvent) {
        // Undo edit = restore previous state
        const res = await apiFetch(`/calendar/event/${eventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(previousEvent)
        });
        if (!res || !res.ok) throw new Error("Restore failed");
        return res.json();
      }
    }
  };
}

/**
 * Create command for event delete
 */
export function createEventDeleteCommand(eventId, previousEvent) {
  return {
    label: "Delete event",
    execute: async () => {
      const res = await apiFetch(`/calendar/event/${eventId}`, { method: "DELETE" });
      if (!res || !res.ok) throw new Error("Delete failed");
    },
    undo: async () => {
      if (previousEvent) {
        const res = await apiFetch("/calendar/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(previousEvent)
        });
        if (!res || !res.ok) throw new Error("Restore failed");
        return res.json();
      }
    }
  };
}

/**
 * Create command for sticky note save
 */
export function createStickySaveCommand(eventId, stickyNotes, previousStickies) {
  return {
    label: "Save sticky note",
    execute: async () => {
      const res = await apiFetch(`/calendar/event/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: stickyNotes })
      });
      if (!res || !res.ok) throw new Error("Save failed");
      return res.json();
    },
    undo: async () => {
      const res = await apiFetch(`/calendar/event/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: previousStickies || [] })
      });
      if (!res || !res.ok) throw new Error("Restore failed");
      return res.json();
    }
  };
}

/**
 * Create command for sticky note deletion
 */
export function createStickyDeleteCommand(eventId, stickyIndex, previousStickies) {
  return {
    label: "Delete sticky note",
    execute: async () => {
      const updated = previousStickies.filter((_, i) => i !== stickyIndex);
      const res = await apiFetch(`/calendar/event/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: updated })
      });
      if (!res || !res.ok) throw new Error("Delete failed");
      return res.json();
    },
    undo: async () => {
      const res = await apiFetch(`/calendar/event/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: previousStickies })
      });
      if (!res || !res.ok) throw new Error("Restore failed");
      return res.json();
    }
  };
}

/**
 * Create command for date sticky note save
 */
export function createDateStickySaveCommand(dateKey, stickyNotes, previousStickies) {
  return {
    label: "Save date sticky note",
    execute: async () => {
      const res = await apiFetch(`/calendar/date-sticky/${encodeURIComponent(dateKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: stickyNotes })
      });
      if (!res || !res.ok) throw new Error("Save failed");
      return res.json();
    },
    undo: async () => {
      const res = await apiFetch(`/calendar/date-sticky/${encodeURIComponent(dateKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky_notes: previousStickies || [] })
      });
      if (!res || !res.ok) throw new Error("Restore failed");
      return res.json();
    }
  };
}

/**
 * Create command for moving sticky between events/dates
 */
export function createMoveStickyCommand(sourceId, targetId, stickyData, moveType) {
  // moveType: "event-to-event", "event-to-date", "date-to-event"
  return {
    label: `Move sticky ${moveType.split("-")[2]}`,
    execute: async () => {
      // Execute move
      if (moveType === "event-to-event") {
        await moveEventStickyToEvent(sourceId, targetId);
      } else if (moveType === "event-to-date") {
        await moveEventStickyToDate(sourceId, targetId);
      } else if (moveType === "date-to-event") {
        await moveDateStickyToEvent(sourceId, targetId);
      }
    },
    undo: async () => {
      // Reverse the move
      if (moveType === "event-to-event") {
        await moveEventStickyToEvent(targetId, sourceId);
      } else if (moveType === "event-to-date") {
        // Undo move back to event
        await moveDateStickyToEvent(targetId, sourceId);
      } else if (moveType === "date-to-event") {
        // Undo move back to date
        await moveEventStickyToDate(sourceId, targetId);
      }
    }
  };
}

export default UndoRedoManager;
