interface EditableLeafResult {
    leaf: unknown | null;
    reason: string | null;
}
interface DocWithEditableLeaf {
    activeEditableLeaf(opts?: Record<string, unknown>): EditableLeafResult;
}
type SetStatus = (msg: string, isError?: boolean) => void;
export declare function requireEditableLeaf(doc: DocWithEditableLeaf, setStatus: SetStatus | null | undefined, opts?: Record<string, unknown>): unknown | null;
export {};
