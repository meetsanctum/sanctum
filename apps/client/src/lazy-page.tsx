import { lazy, useState, type ComponentType } from "react";

/**
 * A page that loads the first time it opens. Once its module has loaded,
 * ahead of time by `preload` or by an earlier opening, it draws at once:
 * React's lazy would still wait a frame for a module already there.
 */
export function lazyPage<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
) {
  let loaded: ComponentType<Props> | undefined;
  const preload = () =>
    load().then((page) => {
      loaded = page;
      return page;
    });
  const Lazy = lazy(() => preload().then((page) => ({ default: page })));
  function Page(props: Props) {
    // Chosen once, so a page that opened before its module had loaded
    // isn't drawn afresh, losing its state, once it has.
    const [Shown] = useState<ComponentType<Props>>(() => loaded ?? Lazy);
    return <Shown {...props} />;
  }
  return { Page, preload };
}
