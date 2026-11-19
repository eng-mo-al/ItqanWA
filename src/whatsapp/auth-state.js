'use strict';

// Baileys auth state persisted in the store (kv table) instead of files,
// because Render's free disk is wiped on every restart.
async function useStoreAuthState(store, B) {
  const { BufferJSON, initAuthCreds, proto } = B;
  const P = 'auth:';
  const ser = (o) => JSON.stringify(o, BufferJSON.replacer);
  const de = (s) => JSON.parse(s, BufferJSON.reviver);

  const raw = await store.get(P + 'creds');
  const creds = raw ? de(raw) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            const v = await store.get(`${P}key:${type}-${id}`);
            if (!v) return;
            let value = de(v);
            if (type === 'app-state-sync-key' && proto && proto.Message && proto.Message.AppStateSyncKeyData) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const jobs = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const key = `${P}key:${type}-${id}`;
              jobs.push(value ? store.set(key, ser(value)) : store.del(key));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => store.set(P + 'creds', ser(creds)),
    clear: async () => {
      const all = await store.list(P);
      await Promise.all(all.map((r) => store.del(r.k)));
    },
    hasCreds: () => !!raw || !!(creds && creds.registered),
  };
}

module.exports = { useStoreAuthState };
