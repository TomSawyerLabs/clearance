import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { get, messageOf, type SiteState } from "./api.ts";

interface SiteContext {
  state: SiteState;
  /** Re-reads who is signed in and the site's settings. */
  refresh(): Promise<SiteState>;
}

const Context = createContext<SiteContext | null>(null);

export function useSite(): SiteContext {
  const value = useContext(Context);
  if (!value) throw new Error("useSite outside SiteProvider");
  return value;
}

export function SiteProvider({
  children,
  loading,
  failed,
}: {
  children: ReactNode;
  loading: ReactNode;
  failed(message: string): ReactNode;
}) {
  const [state, setState] = useState<SiteState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await get<SiteState>("/state");
    setState(next);
    document.title = next.site.name;
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(messageOf(cause)));
  }, [refresh]);

  if (error) return failed(error);
  if (!state) return loading;
  return (
    <Context.Provider value={{ state, refresh }}>{children}</Context.Provider>
  );
}

/** Loads something from the API and reloads it on demand. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  return { data, error, reload };
}

/** Dates are stored in UTC and shown in the site's configured time zone. */
export function useFormat() {
  const { state } = useSite();
  const timeZone = state.site.timezone;
  return {
    date: (iso: string) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone,
        dateStyle: "medium",
      }).format(new Date(iso)),
    dateTime: (iso: string) =>
      // dateStyle/timeStyle cannot be combined with timeZoneName, hence the long form.
      new Intl.DateTimeFormat(undefined, {
        timeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(iso)),
  };
}
