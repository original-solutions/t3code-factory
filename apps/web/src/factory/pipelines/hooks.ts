import { useEffect, useEffectEvent, useState } from "react";

export type Request<T> = {
  readonly data: T | null;
  readonly error: Error | null;
  /** True until the first answer for the current key. */
  readonly loading: boolean;
  readonly reload: () => void;
};

/**
 * One read keyed by `key`, read again on `reload` and whenever the key changes; null reads
 * nothing. An answer for a key that is no longer current is dropped, and the data shown is
 * always the current key's, so switching keys never shows the last one's answer.
 */
export function useRequest<T>(key: string | null, load: () => Promise<T>): Request<T> {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly data: T | null;
    readonly error: Error | null;
  }>({ key: null, data: null, error: null });
  const read = useEffectEvent(load);
  // A reload is a new read of the same key.
  const readKey = key === null ? null : `${version} ${key}`;
  useEffect(() => {
    if (key === null || readKey === null) return;
    let live = true;
    read().then(
      (data) => {
        if (live) setState({ key, data, error: null });
      },
      (cause: unknown) => {
        if (!live) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((last) => ({ key, data: last.key === key ? last.data : null, error }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, readKey]);
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: key !== null && !current,
    reload: () => setVersion((n) => n + 1),
  };
}

/** Calls `tick` every `ms` while `enabled` and the window shows. */
export function usePolling(tick: () => void, ms: number, enabled: boolean): void {
  const onTick = useEffectEvent(tick);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") onTick();
    }, ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
}
