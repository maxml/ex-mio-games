// Strictly-typed translations (next-intl v4 "AppConfig" augmentation): derives
// `Locale` from the routing config and `Messages` from the `en` catalog (the
// reference locale), so `useTranslations` / `getTranslations` keys and the
// `Locale` type are checked at compile time. `import(...)` type queries keep this
// declaration-only file free of runtime imports.
//
// The `export {}` marks this as a module so `declare module` *augments*
// (merges into) next-intl's types — without it the block would be read as an
// ambient declaration that *replaces* the module and hides its real exports.
export {};

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof import('./routing'))['routing']['locales'][number];
    Messages: typeof import('./messages/en.json');
  }
}
