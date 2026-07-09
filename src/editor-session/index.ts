// @local/editor-session —— 唯一公开入口。家族共享深模块（与 sync-store 平级，互拷）。
//   接本模块必读同目录 README.md + CONTEXT.md。
export { createEditorSession } from "./editor-session.ts";
export type {
  EditorSession, EditorSessionConfig, EditorAdapter, StoreLike, LifecyclePolicy,
} from "./editor-session.ts";
