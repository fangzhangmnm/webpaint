export interface PwaShellDeps {
    toast: HTMLElement;
    reloadBtn: HTMLElement;
    dismissBtn: HTMLElement;
    envChip: HTMLElement | null;
    onBeforeReload: () => Promise<void>;
    onForeground: () => void;
}
export declare class PwaShell {
    d: PwaShellDeps;
    reg: ServiceWorkerRegistration | null;
    dismissed: boolean;
    constructor(d: PwaShellDeps);
    show(): void;
    init(): void;
}
