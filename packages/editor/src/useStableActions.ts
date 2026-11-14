/**
 * @apelles/editor — one object of handlers whose identity never changes
 * (B-377 / D-461; generalised from `lanes/useLaneActions.ts`, D-437 S3a).
 *
 * What it is: a hook that takes "the latest handlers from the parent" and hands
 * back ONE object whose identity is fixed for the life of the component. Each
 * method forwards to the latest handler at CALL time (inside an event handler),
 * read through a ref that is written in a layout effect — never during render,
 * which is what keeps the React Compiler from bailing out of the file that uses
 * it ("Cannot access refs during render", B-184/D-201).
 *
 * Why it exists: a `memo`'d child that takes callbacks re-renders whenever one
 * of them gets a new identity, which for a parent like `TimelinePane` is every
 * render. With a fixed-identity action object, the child's props stop changing
 * and the child only re-renders for its own store subscriptions — which is the
 * whole mechanism behind B-377's fix.
 *
 * What it does NOT do: decide what any action means (that stays in the parent),
 * and it does not notice a handler SET that changes shape — the forwarding
 * methods are built once, from the keys of the first render's object, so the key
 * set must be fixed (it is, in every call site: an object literal of methods).
 */
import { useLayoutEffect, useRef, useState } from 'react';

/** A handler object: named methods, nothing else. `never[]` rather than
 *  `unknown[]`/`any[]` so any concrete function type satisfies it (parameters
 *  are contravariant) without an `any` anywhere. */
export type ActionMap = Record<string, (...args: never[]) => unknown>;

/** `latest`, with a permanent identity. Call it with a fresh object literal on
 *  every render; the returned object is the same one every time. */
export function useStableActions<T extends ActionMap>(latest: T): T {
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });
  const [stable] = useState<T>(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(latest)) {
      out[key] = (...args: unknown[]) =>
        (latestRef.current[key] as unknown as (...a: unknown[]) => unknown)(...args);
    }
    return out as T;
  });
  return stable;
}
