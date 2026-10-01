/** 限制 HTTP 请求和响应体读取时间，并保留调用者的取消语义。 */
export function createBoundedFetch(fetcher: typeof fetch = fetch, timeoutMs = 15_000): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : null);
    let finished = false;
    let bodyAbort: (() => void) | null = null;
    const abort = () => controller.abort(caller?.reason);
    if (caller?.aborted) abort();
    else caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("网络请求超时", "TimeoutError")), timeoutMs);
    const cleanup = () => {
      finished = true;
      clearTimeout(timer); caller?.removeEventListener("abort", abort);
      if (bodyAbort) controller.signal.removeEventListener("abort", bodyAbort);
    };
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal });
      if (!response.body) { cleanup(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          bodyAbort = () => {
            if (finished) return;
            stream.error(controller.signal.reason); cleanup();
            void reader.cancel(controller.signal.reason).catch(() => {});
          };
          controller.signal.addEventListener("abort", bodyAbort, { once: true });
          if (controller.signal.aborted) bodyAbort();
        },
        async pull(stream) {
          try {
            const result = await reader.read();
            if (finished) return;
            if (result.done) { cleanup(); stream.close(); }
            else stream.enqueue(result.value);
          } catch (error) { if (!finished) { cleanup(); stream.error(controller.signal.aborted ? controller.signal.reason : error); } }
        },
        async cancel(reason) { cleanup(); controller.abort(reason); await reader.cancel(reason); },
      });
      const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(bounded, {
        url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
      });
      return bounded;
    } catch (error) { cleanup(); throw error; }
  };
}
