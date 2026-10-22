// The raw logger: the one file allowed to call console, so the consoleCalls probe skips it.
export const rawLog = (...args) => console.log(...args);
