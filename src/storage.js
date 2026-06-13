// Reproduz a API assíncrona window.storage usada pelo app,
// mas persistindo no localStorage do navegador (PWA real).
const PREFIX = "ascend:";

window.storage = {
  async get(key) {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? null : { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
    }
    return { keys, prefix };
  },
};
