import type { FilterParams } from "../filters.ts";
interface ColorBalanceParams extends FilterParams {
    shR: number;
    shG: number;
    shB: number;
    mR: number;
    mG: number;
    mB: number;
    hiR: number;
    hiG: number;
    hiB: number;
}
interface ColorBalanceState {
    params: ColorBalanceParams;
}
export declare class ColorBalanceFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(): number;
    static defaults(): {
        shR: number;
        shG: number;
        shB: number;
        mR: number;
        mG: number;
        mB: number;
        hiR: number;
        hiG: number;
        hiB: number;
    };
    static buildBody(container: HTMLElement, state: ColorBalanceState, onChange: () => void): void;
    static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: ColorBalanceParams, mask: Uint8Array | null): void;
}
export {};
