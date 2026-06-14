type IgnoreMouseEventsWindow = {
  setIgnoreCursorEvents(shouldIgnore: boolean): Promise<void>;
} | null;

type ControllerOptions = {
  onError?: (error: unknown) => void;
};

export function createIgnoreMouseEventsController(
  appWindow: IgnoreMouseEventsWindow,
  { onError = console.error }: ControllerOptions = {},
) {
  let desiredIgnore = false;
  let appliedIgnore = false;
  let isApplying = false;

  async function flush() {
    if (!appWindow || isApplying) {
      return;
    }

    isApplying = true;

    try {
      while (appliedIgnore !== desiredIgnore) {
        const nextIgnore = desiredIgnore;
        await appWindow.setIgnoreCursorEvents(nextIgnore);
        appliedIgnore = nextIgnore;
      }
    } catch (error) {
      onError(error);
    } finally {
      isApplying = false;

      if (appliedIgnore !== desiredIgnore) {
        void flush();
      }
    }
  }

  return {
    setIgnoreMouseEvents(shouldIgnore: boolean) {
      if (typeof shouldIgnore !== "boolean" || desiredIgnore === shouldIgnore) {
        return;
      }

      desiredIgnore = shouldIgnore;
      void flush();
    },
  };
}
