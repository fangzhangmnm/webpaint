import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";
export interface PerspPt {
    x: number;
    y: number;
}
export interface PerspHost {
    /** 深拷贝 JSON 快照（workbench-state.snapshotShapePersp）。 */
    snapshot(): unknown;
    /** 整包还原（workbench-state.restoreShapePersp）。 */
    restore(snap: unknown): void;
    /** VP/box 坐标重映射（workbench-state.remapShapePersp）。 */
    remap(f: (p: PerspPt) => PerspPt, opts?: {
        unlockHorizon?: boolean;
    }): void;
}
export declare class PerspComponent implements CollectorComponent {
    readonly kind = "persp";
    private _wp;
    private _host;
    private _origin;
    constructor(wp: Workpiece, host: PerspHost);
    view(): unknown;
    /** doc 几何变换的 VP 重映射（token 写；doc-ops runDocTransform 的 compound 内调）。 */
    remapForDocTransform(f: (p: PerspPt) => PerspPt, opts?: {
        unlockHorizon?: boolean;
    }): void;
    /** 整包换配置（token 写；VP 编辑可撤化的预留口——现无调用方，persp-edit 仍 desk 直写）。 */
    set(cfg: unknown): void;
    sealRecord(): RecordData | null;
    swapRecord(data: RecordData): RecordData;
    recordBytes(data: RecordData): number;
    disposeRecord(): void;
}
