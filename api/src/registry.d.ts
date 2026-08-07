export interface RegistryOpts {
    name?: string;
    idKey?: string;
}
export interface Registry<T> {
    register(item: T): T;
    get(id: unknown): T | null;
    has(id: unknown): boolean;
    list(): T[];
    onRegistered(fn: (item: T) => void): () => void;
}
export declare function makeRegistry<T>({ name, idKey }?: RegistryOpts): Registry<T>;
