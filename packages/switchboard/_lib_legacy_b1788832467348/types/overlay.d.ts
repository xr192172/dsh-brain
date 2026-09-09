export interface OverlayParams {
    /** per-gen sqlite 查询索引路径（避免跨进程锁）。 */
    querySqlitePath: string;
}
export declare function renderOverlayYaml(p: OverlayParams): string;
export declare function writeOverlay(dir: string, p: OverlayParams): string;
