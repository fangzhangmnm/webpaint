export declare function wireInlineSelect<V extends string>(btnId: string, menuId: string, items: () => {
    value: V;
    label: string;
}[], current: () => V, onPick: (v: V) => void): void;
