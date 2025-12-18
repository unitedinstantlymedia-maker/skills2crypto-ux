import { Asset, HistoryEntry } from "@/core/types";

const STORAGE_KEY_HISTORY = 'skills2crypto_history';

export class HistoryStore {
  private static instance: HistoryStore;

  private constructor() {}

  static getInstance(): HistoryStore {
    if (!HistoryStore.instance) {
      HistoryStore.instance = new HistoryStore();
    }
    return HistoryStore.instance;
  }

  getHistory(): HistoryEntry[] {
    const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
    return stored ? JSON.parse(stored) : [];
  }

  addEntry(entry: HistoryEntry) {
    const history = this.getHistory();
    // Prepend new entry
    history.unshift(entry);
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  }
}

export const historyStore = HistoryStore.getInstance();
