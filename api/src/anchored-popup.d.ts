export declare function topToolbarBottom(): number;
interface PositionOpts {
    anchor?: HTMLElement | null;
    align?: "left" | "right";
    offsetY?: number;
    edgeMargin?: number;
    belowToolbars?: boolean;
    clampViewport?: boolean;
}
export declare function positionPopup(popupEl: HTMLElement | null, opts?: PositionOpts): void;
export declare function anchorPopupToBtn(popup: HTMLElement | null, btn: HTMLElement | null, opts?: PositionOpts): void;
export declare function anchorPopupBelowToolbars(popup: HTMLElement | null, btn: HTMLElement | null, offsetY?: number): void;
export {};
