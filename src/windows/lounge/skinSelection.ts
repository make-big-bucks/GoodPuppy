export type SkinSelectionSnapshot = { skin: string; savedSkin: string; skins: string[]; states: string[]; busy: boolean; loading: boolean };

/** 面板实例拥有选择；保存按账号串行，已提交资料回执携带原身份，不操作替换后的面板。 */
export function createSkinSelection<C extends { petId: string; skin: string }>(deps: {
  ownerKey: (context: C) => string;
  load: (context: C) => Promise<{ skins: string[]; states: string[] }>;
  persist: (context: C, skin: string) => Promise<void>;
  render: (snapshot: SkinSelectionSnapshot) => void;
  saved: (context: C, skin: string) => void;
  closed: () => void;
  error: (error: unknown) => void;
}) {
  let current: { context: C; snapshot: SkinSelectionSnapshot } | null = null;
  const writes = new Map<string, Promise<void>>();
  const render = () => { if (current) deps.render({ ...current.snapshot }); };
  const close = () => { if (!current) return; current = null; deps.closed(); };
  const syncSaved = (owner: string, skin: string) => {
    if (!current || deps.ownerKey(current.context) !== owner) return;
    const pristine = current.snapshot.skin === current.snapshot.savedSkin;
    current.snapshot.savedSkin = skin;
    if (pristine && !current.snapshot.busy) current.snapshot.skin = skin;
    render();
  };
  return {
    open(context: C) {
      close();
      context = { ...context };
      const entry = { context, snapshot: { skin: context.skin, savedSkin: context.skin, skins: [context.skin], states: ["idle"], busy: false, loading: true } };
      current = entry; render();
      void deps.load(context).then((options) => {
        if (current !== entry) return;
        entry.snapshot.skins = [...new Set(["default", ...options.skins])];
        entry.snapshot.states = options.states;
        entry.snapshot.loading = false; render();
      }, (error) => { if (current === entry) { entry.snapshot.loading = false; render(); deps.error(error); } });
    },
    select(skin: string) {
      if (!current || current.snapshot.busy || current.snapshot.loading || !current.snapshot.skins.includes(skin)) return;
      current.snapshot.skin = skin; render();
    },
    async save() {
      const entry = current;
      if (!entry || entry.snapshot.busy || entry.snapshot.loading || entry.snapshot.skin === entry.snapshot.savedSkin) return;
      const skin = entry.snapshot.skin;
      const owner = deps.ownerKey(entry.context);
      entry.snapshot.busy = true; render();
      const write = (writes.get(owner) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (current !== entry) return false;
        await deps.persist(entry.context, skin);
        return true;
      });
      const pending = write.then(() => {}, () => {});
      writes.set(owner, pending);
      try {
        const committed = await write;
        if (!committed) return;
        syncSaved(owner, skin);
        if (current === entry) close();
        deps.saved(entry.context, skin);
      } catch (error) { if (current === entry) deps.error(error); }
      finally {
        if (writes.get(owner) === pending) writes.delete(owner);
        if (current === entry) { entry.snapshot.busy = false; render(); }
      }
    },
    syncSaved,
    close,
  };
}
