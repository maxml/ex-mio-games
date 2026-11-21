/** Injection tokens of the store module. */
export const REDEMPTION_STORE = Symbol('REDEMPTION_STORE');
export const REDEMPTION_SAGA = Symbol('REDEMPTION_SAGA');
export const COINS_PORT = Symbol('COINS_PORT');
/** `(tenantId, sandbox) => CasinoRewardPort`: the integrations module provides the real one. */
export const CASINO_ADAPTERS = Symbol('CASINO_ADAPTERS');
