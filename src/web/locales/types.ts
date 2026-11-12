// A translation has the English source's exact shape, with any text at its leaves: a key missing in French, or one
// French has that English lacks, fails the type check.

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

export type Messages<T> = Widen<T>;
