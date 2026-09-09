/**
 * @module @dsh-brain/switchboard/handover-protocol
 *
 * 交接协议共享契约：Switchboard（协调器/前门）与 Handover-agent（代内插件）
 * 之间经 loopback admin HTTP + on-disk JSON 交换的数据结构。
 *
 * 这些类型是**单一真相**（single source）：两端都从这里 import。协议自带的
 * `mode`/`payload` 槽位是方案③（轮内任意点全状态快照）的预留 seam——第一版
 * 恒 `mode:'replay'`、`payload:undefined`，未来补快照可无感升级。
 */
export {};
