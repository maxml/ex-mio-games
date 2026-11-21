import 'reflect-metadata';
import type { DynamicModule, Type } from '@nestjs/common';
import { ACTIONS } from '@ex-mio/contracts';
import { ActingCoinGuard, COIN_ACTION_KEY, NO_COIN_EFFECT_KEY } from '../controllers/coin-action';

/*
 * Test helper for INV-ACTBAN-7/8 and INV-WIRE-3 (D-14, review finding N3). It walks the module
 * TREE of an app module (imports, dynamic modules, forwardRef), not a list that someone has to
 * remember to extend, so a controller registered in an imported child module is found too.
 * It is a helper for the frozen tests, not implementation: it reads Nest's own module metadata.
 */

type ModuleLike = Type<unknown> | DynamicModule | { forwardRef: () => ModuleLike } | undefined;

const isDynamic = (m: unknown): m is DynamicModule =>
  typeof m === 'object' && m !== null && 'module' in m;
const isForwardRef = (m: unknown): m is { forwardRef: () => ModuleLike } =>
  typeof m === 'object' && m !== null && 'forwardRef' in m;

/** Every controller class reachable from `root` through `imports`, once each. */
export function collectControllers(root: ModuleLike): Type[] {
  const seen = new Set<unknown>();
  const found = new Set<Type>();
  const visit = (m: ModuleLike): void => {
    if (!m) return;
    if (isForwardRef(m)) return visit(m.forwardRef());
    if (seen.has(m)) return;
    seen.add(m);
    const cls = (isDynamic(m) ? m.module : m) as Type;
    const own = [
      ...((Reflect.getMetadata('controllers', cls) as Type[] | undefined) ?? []),
      ...(isDynamic(m) ? (m.controllers ?? []) : []),
    ];
    for (const c of own) found.add(c as Type);
    const imports = [
      ...((Reflect.getMetadata('imports', cls) as ModuleLike[] | undefined) ?? []),
      ...(isDynamic(m) ? ((m.imports ?? []) as ModuleLike[]) : []),
    ];
    imports.forEach(visit);
  };
  visit(root);
  return [...found];
}

/** The route handlers of a controller: methods that carry Nest's `path` metadata. */
export function routeHandlers(ctrl: Type): Array<{ name: string; handler: object }> {
  return Object.getOwnPropertyNames(ctrl.prototype)
    .filter((n) => n !== 'constructor')
    .map((name) => ({
      name,
      handler: (ctrl.prototype as Record<string, unknown>)[name] as object,
    }))
    .filter(({ handler }) => typeof handler === 'function' && Reflect.hasMetadata('path', handler));
}

/**
 * Names of the controllers that break the payments coin rules: no `ActingCoinGuard`, or a route
 * that declares neither a known coin action, `@NoCoinEffect()` nor `@Public()`. A controller whose
 * every route is `@Public()` with no coin action (service-kit's health controller, reached through
 * an imported module) needs no guard: there is no token on it, so no acting claim.
 */
export function coinRuleViolations(root: ModuleLike): string[] {
  const bad: string[] = [];
  for (const ctrl of collectControllers(root)) {
    const guards = (Reflect.getMetadata('__guards__', ctrl) as unknown[] | undefined) ?? [];
    const handlers = routeHandlers(ctrl);
    const onlyPublic =
      handlers.length > 0 &&
      handlers.every(
        ({ handler }) =>
          Reflect.getMetadata('ex-mio:public', handler) === true &&
          Reflect.getMetadata(COIN_ACTION_KEY, handler) === undefined,
      );
    if (!onlyPublic && !guards.includes(ActingCoinGuard))
      bad.push(`${ctrl.name}: no ActingCoinGuard`);
    for (const { name, handler } of handlers) {
      const action = Reflect.getMetadata(COIN_ACTION_KEY, handler) as string | undefined;
      const noEffect = Reflect.getMetadata(NO_COIN_EFFECT_KEY, handler) === true;
      const isPublic = Reflect.getMetadata('ex-mio:public', handler) === true;
      if (action === undefined && !noEffect && !isPublic)
        bad.push(`${ctrl.name}.${name}: undeclared`);
      if (action !== undefined && !(ACTIONS as readonly string[]).includes(action)) {
        bad.push(`${ctrl.name}.${name}: unknown action ${action}`);
      }
    }
  }
  return bad;
}
