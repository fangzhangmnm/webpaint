import type { CloudItem, FolderDeleteResult } from "./types.ts";
export declare function deleteEmptyFolderVia(getItemByPath: (path: string) => Promise<CloudItem | null>, list: (path: string) => Promise<CloudItem[]>, deleteById: (id: string, eTag?: string | null) => Promise<void>, path: string): Promise<FolderDeleteResult>;
